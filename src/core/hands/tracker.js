// Camera + MediaPipe HandLandmarker (VIDEO mode). Loaded lazily so mouse mode never touches the CDN.

const VERSION = '0.10.14';
const BUNDLE = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${VERSION}/vision_bundle.mjs`;
const WASM = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${VERSION}/wasm`;
const MODEL = 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';

export async function loadHandLandmarker(numHands = 2) {
  const { FilesetResolver, HandLandmarker } = await import(BUNDLE);
  const fileset = await FilesetResolver.forVisionTasks(WASM);
  const create = delegate => HandLandmarker.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: MODEL, delegate },
    runningMode: 'VIDEO',
    numHands,
    minHandDetectionConfidence: 0.5,
    minHandPresenceConfidence: 0.5,
    minTrackingConfidence: 0.5,
  });
  try { return await create('GPU'); } catch { return create('CPU'); }
}

export async function startCamera(video) {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 60 } },
  });
  video.srcObject = stream;
  await video.play();
  return stream;
}

export function stopCamera(video) {
  for (const track of video.srcObject?.getTracks?.() ?? []) track.stop();
  video.srcObject = null;
}

// Wraps a landmarker + video: detect() returns landmarks only when a new video frame arrived.
export function createHandTracker(landmarker, video) {
  let lastVideoTime = -1;
  let lastTimestamp = 0;
  return {
    detect() {
      if (video.readyState < 2 || video.currentTime === lastVideoTime) return null;
      lastVideoTime = video.currentTime;
      lastTimestamp = Math.max(lastTimestamp + 1, performance.now());
      return landmarker.detectForVideo(video, lastTimestamp).landmarks ?? [];
    },
    close() { landmarker.close?.(); },
  };
}

// Maps normalised landmark coordinates onto a stage that shows the video mirrored with
// object-fit: cover. Everything downstream (strings, plucks, drawing) uses these mirrored pixels.
export function createCoverMapper(video, stage) {
  return function toStage(point) {
    const vw = video.videoWidth || 1280, vh = video.videoHeight || 720;
    const scale = Math.max(stage.width / vw, stage.height / vh);
    const offsetX = (stage.width - vw * scale) / 2;
    const offsetY = (stage.height - vh * scale) / 2;
    return {
      x: stage.width - (point.x * vw * scale + offsetX),
      y: point.y * vh * scale + offsetY,
      z: (point.z ?? 0) * vw * scale,
    };
  };
}
