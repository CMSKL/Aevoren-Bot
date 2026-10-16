import type { ElectronApplication } from "@playwright/test";

/** Test-only encoder of generated pixels/sine; never uses getUserMedia/display capture. */
export async function recording(application: ElectronApplication, video: boolean): Promise<Uint8Array> {
  const bytes = await application.evaluate(async ({ BrowserWindow }, includeVideo) => {
    const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
    try {
      await window.loadURL("data:text/html,<meta charset=utf-8><title>Owned encoder fixture</title>");
      return await window.webContents.executeJavaScript(`(async () => {
        const context = new AudioContext(), destination = context.createMediaStreamDestination(), oscillator = context.createOscillator();
        oscillator.frequency.value = 440; oscillator.connect(destination); oscillator.start(); await context.resume();
        const canvas = document.createElement('canvas'); canvas.width = 32; canvas.height = 24;
        const drawing = canvas.getContext('2d'); drawing.fillStyle = '#f00'; drawing.fillRect(0,0,32,24);
        const pixels = canvas.captureStream(20), stream = new MediaStream([...destination.stream.getAudioTracks(), ...(${includeVideo} ? pixels.getVideoTracks() : [])]);
        const recorder = new MediaRecorder(stream, { mimeType: ${JSON.stringify(includeVideo ? "video/webm;codecs=vp8,opus" : "audio/webm;codecs=opus")} });
        const chunks = []; let firstTimecode = null;
        const done = new Promise((resolve,reject) => {
          recorder.ondataavailable = event => {
            if (!event.data.size) return;
            chunks.push(event.data); firstTimecode ??= event.timecode;
            // Encoding can start later than the Renderer timer under CI load.
            // Wait for actual emitted media, not elapsed wall time/header bytes.
            if (event.timecode - firstTimecode >= 200 && recorder.state === 'recording') recorder.stop();
          };
          recorder.onstop = async () => resolve(Array.from(new Uint8Array(await new Blob(chunks).arrayBuffer()))); recorder.onerror = reject;
        });
        const tick = setInterval(() => { drawing.fillRect(0,0,32,24); pixels.getVideoTracks()[0]?.requestFrame(); }, 30);
        try { recorder.start(50); return await done; }
        finally { clearInterval(tick); oscillator.stop(); for (const track of [...stream.getTracks(), ...pixels.getTracks()]) track.stop(); await context.close(); }
      })()`);
    } finally { window.destroy(); }
  }, video);
  return Uint8Array.from(bytes);
}
