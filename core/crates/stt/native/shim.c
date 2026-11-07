// Thin C shim over whisper.dll. Loads the DLL at runtime (no import library) and
// hides struct layouts (whisper_full_params is passed by value) from Rust.
// Compiled against headers of the exact DLL version (native/include/VERSION).

#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <math.h>
#include <stdio.h>
#include <string.h>
#include "whisper.h"

typedef struct whisper_context *(*p_init_from_file_with_params)(const char *, struct whisper_context_params);
typedef struct whisper_context_params (*p_context_default_params)(void);
typedef struct whisper_state *(*p_init_state)(struct whisper_context *);
typedef struct whisper_full_params (*p_full_default_params)(enum whisper_sampling_strategy);
typedef int (*p_full_with_state)(struct whisper_context *, struct whisper_state *, struct whisper_full_params, const float *, int);
typedef int (*p_n_segments)(struct whisper_state *);
typedef const char *(*p_segment_text)(struct whisper_state *, int);
typedef int64_t (*p_segment_t)(struct whisper_state *, int);
typedef float (*p_no_speech)(struct whisper_state *, int);
typedef int (*p_n_tokens)(struct whisper_state *, int);
typedef whisper_token_data (*p_token_data)(struct whisper_state *, int, int);
typedef whisper_token (*p_token_ctx)(struct whisper_context *);
typedef int (*p_lang_id)(struct whisper_state *);
typedef const char *(*p_lang_str)(int);
typedef void (*p_free_state)(struct whisper_state *);
typedef void (*p_free)(struct whisper_context *);
typedef const char *(*p_sysinfo)(void);
typedef void (*p_log_set)(ggml_log_callback, void *);

static struct {
    p_init_from_file_with_params init_from_file_with_params;
    p_context_default_params context_default_params;
    p_init_state init_state;
    p_full_default_params full_default_params;
    p_full_with_state full_with_state;
    p_n_segments n_segments;
    p_segment_text segment_text;
    p_no_speech no_speech;
    p_n_tokens n_tokens;
    p_token_data token_data;
    p_token_ctx token_eot;
    p_lang_id lang_id;
    p_lang_str lang_str;
    p_free_state free_state;
    p_free free_ctx;
    p_sysinfo sysinfo;
    p_log_set log_set;
} W;

static int g_loaded = 0;
static int g_verbose = 0;

static void quiet_log(enum ggml_log_level level, const char *text, void *user) {
    (void)user;
    if (g_verbose || level >= GGML_LOG_LEVEL_WARN) fputs(text, stderr);
}

#define LOAD(field, name)                                                         \
    W.field = (void *)GetProcAddress(h, name);                                     \
    if (!W.field) {                                                                \
        snprintf(err, errlen, "symbol %s not found in whisper.dll", name);        \
        return -2;                                                                 \
    }

// dll_path: full path to whisper.dll. Its directory is added to the DLL search
// path so ggml*.dll and the CUDA runtime next to it resolve.
// cuda_dll: NULL, or the full path to a ggml-cuda.dll downloaded apart from the app
// (Settings), with its cudart/cublas next to it. If it fails to load, whisper runs on the CPU.
int ws_load(const wchar_t *dll_path, const wchar_t *cuda_dll, int verbose, char *err, int errlen) {
    if (g_loaded) return 0;
    g_verbose = verbose;
    // ggml loads its backends (ggml-cuda.dll, ggml-cpu-*.dll) later with a plain
    // LoadLibraryW, and those depend on cudart/cublas next to them. Add the
    // whisper directory to the standard DLL search order for the process.
    {
        wchar_t dirw[MAX_PATH * 2];
        wcsncpy_s(dirw, MAX_PATH * 2, dll_path, _TRUNCATE);
        wchar_t *bs = wcsrchr(dirw, L'\\');
        if (bs) *bs = 0;
        if (!SetDllDirectoryW(dirw)) {
            snprintf(err, errlen, "SetDllDirectoryW failed, error %lu", GetLastError());
            return -1;
        }
    }
    HMODULE h = LoadLibraryExW(dll_path, NULL, LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR | LOAD_LIBRARY_SEARCH_DEFAULT_DIRS);
    if (!h) {
        snprintf(err, errlen, "LoadLibraryExW failed, error %lu", GetLastError());
        return -1;
    }
    // whisper.dll is a GGML_BACKEND_DL build: backends (ggml-cuda.dll, ggml-cpu-*.dll)
    // are discovered at runtime, by default next to the *executable*. Load them
    // from the DLL's own directory instead.
    {
        typedef void (*p_load_all_from_path)(const char *);
        typedef void *(*p_backend_load)(const char *);
        HMODULE g = GetModuleHandleW(L"ggml.dll");
        if (cuda_dll && g) {
            // Altered search path: its dependencies resolve from its own directory.
            p_backend_load backend_load = (p_backend_load)(void *)GetProcAddress(g, "ggml_backend_load");
            char cuda[MAX_PATH * 3];
            if (!backend_load || !LoadLibraryExW(cuda_dll, NULL, LOAD_WITH_ALTERED_SEARCH_PATH) ||
                WideCharToMultiByte(CP_UTF8, 0, cuda_dll, -1, cuda, sizeof(cuda), NULL, NULL) <= 0 || !backend_load(cuda)) {
                fprintf(stderr, "ggml-cuda.dll did not load (error %lu), whisper runs on the CPU\n", GetLastError());
            }
        }
        p_load_all_from_path load_all = g ? (p_load_all_from_path)(void *)GetProcAddress(g, "ggml_backend_load_all_from_path") : NULL;
        if (!load_all) {
            snprintf(err, errlen, "ggml_backend_load_all_from_path not found in ggml.dll");
            return -3;
        }
        char dir[MAX_PATH * 3];
        int n = WideCharToMultiByte(CP_UTF8, 0, dll_path, -1, dir, sizeof(dir), NULL, NULL);
        if (n <= 0) {
            snprintf(err, errlen, "bad dll path");
            return -3;
        }
        char *slash = strrchr(dir, '\\');
        if (slash) *slash = 0;
        load_all(dir);
    }
    LOAD(init_from_file_with_params, "whisper_init_from_file_with_params");
    LOAD(context_default_params, "whisper_context_default_params");
    LOAD(init_state, "whisper_init_state");
    LOAD(full_default_params, "whisper_full_default_params");
    LOAD(full_with_state, "whisper_full_with_state");
    LOAD(n_segments, "whisper_full_n_segments_from_state");
    LOAD(segment_text, "whisper_full_get_segment_text_from_state");
    LOAD(no_speech, "whisper_full_get_segment_no_speech_prob_from_state");
    LOAD(n_tokens, "whisper_full_n_tokens_from_state");
    LOAD(token_data, "whisper_full_get_token_data_from_state");
    LOAD(token_eot, "whisper_token_eot");
    LOAD(lang_id, "whisper_full_lang_id_from_state");
    LOAD(lang_str, "whisper_lang_str");
    LOAD(free_state, "whisper_free_state");
    LOAD(free_ctx, "whisper_free");
    LOAD(sysinfo, "whisper_print_system_info");
    LOAD(log_set, "whisper_log_set");
    W.log_set(quiet_log, NULL);
    g_loaded = 1;
    return 0;
}

const char *ws_system_info(void) { return g_loaded ? W.sysinfo() : ""; }

void *ws_init(const char *model_path_utf8, int use_gpu, int gpu_device, int flash_attn) {
    if (!g_loaded) return NULL;
    struct whisper_context_params cp = W.context_default_params();
    cp.use_gpu = use_gpu != 0;
    cp.gpu_device = gpu_device;
    cp.flash_attn = flash_attn != 0;
    return W.init_from_file_with_params(model_path_utf8, cp);
}

void *ws_state_new(void *ctx) { return W.init_state((struct whisper_context *)ctx); }
void ws_state_free(void *state) { W.free_state((struct whisper_state *)state); }
void ws_free(void *ctx) { W.free_ctx((struct whisper_context *)ctx); }

typedef struct {
    const char *language;       // NULL/"auto" = detect
    const char *initial_prompt; // may be NULL
    int n_threads;
    int beam_size;              // <= 1 -> greedy
    int single_segment;
    int no_timestamps;
    float temperature_inc;      // 0 disables fallback re-decodes
    float no_speech_thold;
    int audio_ctx;              // 0 = full 30 s context
    volatile const int *abort_flag; // non-zero aborts decoding; may be NULL
    unsigned int timeout_ms;        // 0 = no limit
} ws_opts;

typedef struct {
    volatile const int *flag;
    ULONGLONG deadline; // GetTickCount64 ms, 0 = none
} abort_ctx;

static bool abort_cb(void *user) {
    const abort_ctx *a = (const abort_ctx *)user;
    return (a->flag && *a->flag != 0) || (a->deadline && GetTickCount64() > a->deadline);
}

// Returns 0 on success, WS_TIMED_OUT past timeout_ms, other non-zero on failure/abort.
#define WS_TIMED_OUT -1000
int ws_full(void *ctx, void *state, const float *samples, int n, const ws_opts *o) {
    enum whisper_sampling_strategy strat = o->beam_size > 1 ? WHISPER_SAMPLING_BEAM_SEARCH : WHISPER_SAMPLING_GREEDY;
    struct whisper_full_params p = W.full_default_params(strat);
    p.n_threads = o->n_threads;
    p.translate = false;
    p.no_context = true; // we pass context explicitly via initial_prompt
    p.no_timestamps = o->no_timestamps != 0;
    p.single_segment = o->single_segment != 0;
    p.print_special = false;
    p.print_progress = false;
    p.print_realtime = false;
    p.print_timestamps = false;
    p.suppress_blank = true;
    p.suppress_nst = true;
    p.temperature = 0.0f;
    p.temperature_inc = o->temperature_inc;
    p.no_speech_thold = o->no_speech_thold;
    p.audio_ctx = o->audio_ctx;
    if (o->beam_size > 1) p.beam_search.beam_size = o->beam_size;
    p.initial_prompt = o->initial_prompt;
    if (o->language && o->language[0] && strcmp(o->language, "auto") != 0) {
        p.language = o->language;
        p.detect_language = false;
    } else {
        p.language = "auto";
    }
    abort_ctx ac = {o->abort_flag, o->timeout_ms ? GetTickCount64() + o->timeout_ms : 0};
    if (ac.flag || ac.deadline) {
        p.abort_callback = abort_cb;
        p.abort_callback_user_data = &ac;
    }
    int rc = W.full_with_state((struct whisper_context *)ctx, (struct whisper_state *)state, p, samples, n);
    if (rc != 0 && ac.deadline && GetTickCount64() > ac.deadline) return WS_TIMED_OUT;
    return rc;
}

int ws_n_segments(void *state) { return W.n_segments((struct whisper_state *)state); }
const char *ws_segment_text(void *state, int i) { return W.segment_text((struct whisper_state *)state, i); }
float ws_segment_no_speech(void *state, int i) { return W.no_speech((struct whisper_state *)state, i); }

// Mean log-probability of the text tokens of a segment (special tokens >= EOT excluded).
float ws_segment_avg_logprob(void *ctx, void *state, int i) {
    struct whisper_state *st = (struct whisper_state *)state;
    whisper_token eot = W.token_eot((struct whisper_context *)ctx);
    int n = W.n_tokens(st, i);
    double sum = 0.0;
    int cnt = 0;
    for (int t = 0; t < n; t++) {
        whisper_token_data d = W.token_data(st, i, t);
        if (d.id >= eot) continue;
        sum += d.plog;
        cnt++;
    }
    return cnt ? (float)(sum / cnt) : 0.0f;
}

const char *ws_lang(void *state) {
    int id = W.lang_id((struct whisper_state *)state);
    return id >= 0 ? W.lang_str(id) : "";
}
