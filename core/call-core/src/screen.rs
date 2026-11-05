//! Screenshot of what the user looks at (docs/ARCHITECTURE.md §7): the foreground window as it
//! appears on screen, or a whole monitor. BitBlt from the screen DC goes through DWM composition,
//! so GPU-drawn apps come out right and windows with WDA_EXCLUDEFROMCAPTURE (our overlays) are left out.

use std::io::Cursor;

use anyhow::{Context, Result, bail};
use image::codecs::jpeg::JpegEncoder;
use image::codecs::png::{CompressionType, FilterType as PngFilter, PngEncoder};
use image::imageops::{self, FilterType};
use image::{ImageEncoder, RgbImage, RgbaImage};
use windows::Win32::Foundation::{HWND, POINT, RECT};
use windows::Win32::Graphics::Dwm::{DWMWA_EXTENDED_FRAME_BOUNDS, DwmGetWindowAttribute};
use windows::Win32::Graphics::Gdi::{
    BI_RGB, BITMAPINFO, BITMAPINFOHEADER, BitBlt, CAPTUREBLT, CreateCompatibleBitmap, CreateCompatibleDC, DIB_RGB_COLORS, DeleteDC,
    DeleteObject, GetDC, GetDIBits, GetMonitorInfoW, HMONITOR, MONITOR_DEFAULTTONEAREST, MONITORINFO, MonitorFromPoint, MonitorFromWindow,
    ReleaseDC, SRCCOPY, SelectObject,
};
use windows::Win32::UI::HiDpi::{DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2, SetProcessDpiAwarenessContext};
use windows::Win32::UI::WindowsAndMessaging::{GetCursorPos, GetForegroundWindow, GetWindowDisplayAffinity, GetWindowTextW, WDA_EXCLUDEFROMCAPTURE};

/// Larger images are scaled down server-side anyway; tokens ≈ w·h/750.
const MAX_SIDE: u32 = 1568;
const THUMB_SIDE: u32 = 320;

pub struct Shot {
    pub png: Vec<u8>,
    pub width: u32,
    pub height: u32,
    /// dHash of the picture: close hashes mean the screen did not change.
    pub hash: u64,
    /// Small JPEG for the UI card.
    pub thumb: Vec<u8>,
    /// What was captured, for the log.
    pub source: String,
}

/// Physical pixels: without this a scaled display reports and blits virtualized coordinates.
pub fn dpi_aware() {
    // Fails harmlessly if the process already has a DPI mode.
    let _ = unsafe { SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2) };
}

/// The display affinity of a window (0x11 = WDA_EXCLUDEFROMCAPTURE, hidden from capture).
pub fn affinity(hwnd: isize) -> Result<u32> {
    let mut a = 0u32;
    unsafe { GetWindowDisplayAffinity(HWND(hwnd as _), &mut a) }?;
    Ok(a)
}

fn monitor_rect(m: HMONITOR) -> Result<RECT> {
    let mut info = MONITORINFO { cbSize: size_of::<MONITORINFO>() as u32, ..Default::default() };
    if !unsafe { GetMonitorInfoW(m, &mut info) }.as_bool() {
        bail!("GetMonitorInfoW failed");
    }
    Ok(info.rcMonitor)
}

fn cursor_monitor() -> Result<RECT> {
    let mut p = POINT::default();
    unsafe { GetCursorPos(&mut p) }?;
    monitor_rect(unsafe { MonitorFromPoint(p, MONITOR_DEFAULTTONEAREST) })
}

fn title(hwnd: HWND) -> String {
    let mut buf = [0u16; 256];
    let n = unsafe { GetWindowTextW(hwnd, &mut buf) };
    String::from_utf16_lossy(&buf[..n.max(0) as usize])
}

/// The rectangle to capture: the foreground window's visible frame clipped to its monitor, or a
/// whole monitor (`monitor`, or when the foreground window is one of ours, which capture skips anyway).
fn target(monitor: bool) -> Result<(RECT, String)> {
    let hwnd = unsafe { GetForegroundWindow() };
    if monitor || hwnd.0.is_null() {
        return Ok((cursor_monitor()?, "монитор".into()));
    }
    let mut a = 0u32;
    if unsafe { GetWindowDisplayAffinity(hwnd, &mut a) }.is_ok() && a == WDA_EXCLUDEFROMCAPTURE.0 {
        return Ok((cursor_monitor()?, "монитор (в фокусе окно ассистента)".into()));
    }
    let mut r = RECT::default();
    unsafe { DwmGetWindowAttribute(hwnd, DWMWA_EXTENDED_FRAME_BOUNDS, &mut r as *mut RECT as *mut _, size_of::<RECT>() as u32) }?;
    let m = monitor_rect(unsafe { MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST) })?;
    let clipped = RECT { left: r.left.max(m.left), top: r.top.max(m.top), right: r.right.min(m.right), bottom: r.bottom.min(m.bottom) };
    if clipped.right - clipped.left < 64 || clipped.bottom - clipped.top < 64 {
        return Ok((m, "монитор (окно свёрнуто или за экраном)".into()));
    }
    Ok((clipped, title(hwnd)))
}

/// Screen pixels of `r` (virtual-screen coordinates) as RGBA.
fn grab(r: RECT) -> Result<RgbaImage> {
    let (w, h) = (r.right - r.left, r.bottom - r.top);
    unsafe {
        let screen = GetDC(None);
        let mem = CreateCompatibleDC(Some(screen));
        let bmp = CreateCompatibleBitmap(screen, w, h);
        let old = SelectObject(mem, bmp.into());
        // CAPTUREBLT: include layered windows, as the user sees them.
        let blit = BitBlt(mem, 0, 0, w, h, Some(screen), r.left, r.top, SRCCOPY | CAPTUREBLT);
        let mut info = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: w,
                biHeight: -h, // top-down rows
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB.0,
                ..Default::default()
            },
            ..Default::default()
        };
        let mut buf = vec![0u8; (w * h * 4) as usize];
        SelectObject(mem, old);
        let lines = GetDIBits(mem, bmp, 0, h as u32, Some(buf.as_mut_ptr() as *mut _), &mut info, DIB_RGB_COLORS);
        let _ = DeleteObject(bmp.into());
        let _ = DeleteDC(mem);
        ReleaseDC(None, screen);
        blit.context("BitBlt")?;
        if lines != h {
            bail!("GetDIBits returned {lines} of {h} lines");
        }
        // BGRA -> RGBA, opaque.
        for px in buf.chunks_exact_mut(4) {
            px.swap(0, 2);
            px[3] = 255;
        }
        RgbaImage::from_raw(w as u32, h as u32, buf).context("bitmap size")
    }
}

/// Long side at most `max`; never upscales.
pub fn fit(img: &RgbaImage, max: u32, filter: FilterType) -> RgbaImage {
    let (w, h) = img.dimensions();
    if w.max(h) <= max {
        return img.clone();
    }
    let k = max as f64 / w.max(h) as f64;
    imageops::resize(img, ((w as f64 * k).round() as u32).max(1), ((h as f64 * k).round() as u32).max(1), filter)
}

/// Difference hash: 9×8 grayscale, one bit per horizontal neighbour pair.
pub fn dhash(img: &RgbaImage) -> u64 {
    let small = imageops::grayscale(&imageops::resize(img, 9, 8, FilterType::Triangle));
    let mut h = 0u64;
    for y in 0..8 {
        for x in 0..8 {
            h = (h << 1) | (small.get_pixel(x, y)[0] < small.get_pixel(x + 1, y)[0]) as u64;
        }
    }
    h
}

/// Hashes this close (Hamming distance) are the same screen; cursor blinks and clocks stay under it.
pub fn same_screen(a: u64, b: u64) -> bool {
    (a ^ b).count_ones() <= 4
}

pub fn encode(img: &RgbaImage, source: String) -> Result<Shot> {
    let big = fit(img, MAX_SIDE, FilterType::Lanczos3);
    let mut png = Vec::new();
    // Fast compression: a few hundred KB more is nothing next to the encode time saved.
    PngEncoder::new_with_quality(Cursor::new(&mut png), CompressionType::Fast, PngFilter::Adaptive).write_image(
        big.as_raw(),
        big.width(),
        big.height(),
        image::ExtendedColorType::Rgba8,
    )?;
    let small: RgbImage = image::DynamicImage::ImageRgba8(fit(&big, THUMB_SIDE, FilterType::Triangle)).to_rgb8();
    let mut thumb = Vec::new();
    JpegEncoder::new_with_quality(&mut thumb, 80).write_image(small.as_raw(), small.width(), small.height(), image::ExtendedColorType::Rgb8)?;
    Ok(Shot { png, width: big.width(), height: big.height(), hash: dhash(&big), thumb, source })
}

/// The foreground window (or the monitor under the cursor), ready to send.
pub fn capture(monitor: bool) -> Result<Shot> {
    let (r, source) = target(monitor)?;
    encode(&grab(r)?, source)
}

/// A rectangle in physical virtual-screen pixels (the privacy self-test passes a display's bounds).
pub fn capture_rect(x: i32, y: i32, w: i32, h: i32) -> Result<Shot> {
    if w < 1 || h < 1 {
        bail!("empty rectangle");
    }
    encode(&grab(RECT { left: x, top: y, right: x + w, bottom: y + h })?, format!("{w}x{h} at {x},{y}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn stripes(w: u32, h: u32, period: u32) -> RgbaImage {
        RgbaImage::from_fn(w, h, |x, _| if (x / period) % 2 == 0 { image::Rgba([0, 0, 0, 255]) } else { image::Rgba([255, 255, 255, 255]) })
    }

    #[test]
    fn fit_keeps_aspect_and_never_upscales() {
        assert_eq!(fit(&stripes(3840, 2160, 8), MAX_SIDE, FilterType::Triangle).dimensions(), (1568, 882));
        assert_eq!(fit(&stripes(800, 600, 8), MAX_SIDE, FilterType::Triangle).dimensions(), (800, 600));
        assert_eq!(fit(&stripes(1000, 3000, 8), MAX_SIDE, FilterType::Triangle).dimensions(), (523, 1568));
    }

    #[test]
    fn dhash_tells_screens_apart() {
        let a = stripes(1600, 900, 200);
        let mut b = a.clone();
        b.put_pixel(5, 5, image::Rgba([10, 10, 10, 255])); // a blinking cursor
        assert!(same_screen(dhash(&a), dhash(&b)));
        let c = RgbaImage::from_fn(1600, 900, |x, y| image::Rgba([(x / 7) as u8, (y / 4) as u8, 0, 255]));
        assert!(!same_screen(dhash(&a), dhash(&c)));
    }

    #[test]
    fn encode_png_and_thumb() {
        let s = encode(&stripes(1920, 1080, 16), "test".into()).unwrap();
        assert_eq!((s.width, s.height), (1568, 882));
        assert_eq!(&s.png[1..4], b"PNG");
        assert_eq!(&s.thumb[..2], &[0xff, 0xd8]);
    }
}
