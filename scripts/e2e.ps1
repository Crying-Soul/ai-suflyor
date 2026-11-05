Start-Sleep 7
foreach ($f in 'mid_k8s','short_why','ru_question') {
  (New-Object Media.SoundPlayer "C:\dev\interviewer\core\testdata\$f.wav").PlaySync()
  Start-Sleep 2
}
