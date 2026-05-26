// State variables
let streamSid = null;
let callSid = null;
let activeBrowserWs = null;
let mediaRecorder = null;
let micStream = null;
let isMuted = false;
let isCallActive = false;
let chunkTimeout = null;

// Web Audio API state for playback and visualization
let audioCtx = null;
let micAnalyser = null;
let recipientAnalyser = null;
let micSourceNode = null;
let recipientNode = null; // Destination node to route received audio through analyser

// DOM Elements
const elevenlabsKeyInput = document.getElementById("elevenlabsKey");
const twilioSidInput = document.getElementById("twilioSid");
const twilioTokenInput = document.getElementById("twilioToken");
const fromNumberInput = document.getElementById("fromNumber");
const toNumberInput = document.getElementById("toNumber");
const voiceSelect = document.getElementById("voiceSelect");
const btnRefreshVoices = document.getElementById("btnRefreshVoices");
const tunnelUrlSpan = document.getElementById("tunnelUrl");
const btnCall = document.getElementById("btnCall");
const btnHangUp = document.getElementById("btnHangUp");
const btnMute = document.getElementById("btnMute");
const muteIcon = document.getElementById("muteIcon");
const appStatusBadge = document.getElementById("appStatus");
const appStatusLabel = appStatusBadge.querySelector(".label");
const logsConsole = document.getElementById("logsConsole");
const btnClearLogs = document.getElementById("btnClearLogs");
const visualizerCanvas = document.getElementById("visualizerCanvas");

// Initialize application
window.addEventListener("DOMContentLoaded", () => {
  loadSettings();
  setupEventListeners();
  initVisualizer();
  connectBrowserWs();
});

// Logs helper
function logMessage(text, type = "system") {
  const line = document.createElement("div");
  line.className = `log-line ${type}`;
  
  const timestamp = new Date().toLocaleTimeString();
  line.textContent = `[${timestamp}] ${text}`;
  
  logsConsole.appendChild(line);
  logsConsole.scrollTop = logsConsole.scrollHeight;
}

// Fetch settings from server (.env) or fallback to local storage
async function loadSettings() {
  try {
    logMessage("Retrieving settings from server...");
    const response = await fetch("/api/settings");
    if (!response.ok) throw new Error("Failed to load settings");
    const settings = await response.json();
    
    // Set values from server, fallback to local storage if empty
    elevenlabsKeyInput.value = settings.elevenlabsApiKey || localStorage.getItem("elevenlabs_key") || "";
    twilioSidInput.value = settings.twilioAccountSid || localStorage.getItem("twilio_sid") || "";
    twilioTokenInput.value = settings.twilioAuthToken || localStorage.getItem("twilio_token") || "";
    fromNumberInput.value = settings.twilioPhoneNumber || localStorage.getItem("from_number") || "+18669423712";
    
    // Non-credentials always fallback to local storage
    toNumberInput.value = localStorage.getItem("to_number") || "";
    
    logMessage("Settings loaded.", "success");
    refreshVoicesList();
  } catch (err) {
    console.error("Error loading server settings:", err);
    logMessage("Failed to load settings from server. Falling back to local storage.", "warning");
    loadCachedCredentials();
    refreshVoicesList();
  }
}

// Fallback load credentials from local storage
function loadCachedCredentials() {
  if (localStorage.getItem("elevenlabs_key")) {
    elevenlabsKeyInput.value = localStorage.getItem("elevenlabs_key");
  }
  if (localStorage.getItem("twilio_sid")) {
    twilioSidInput.value = localStorage.getItem("twilio_sid");
  }
  if (localStorage.getItem("twilio_token")) {
    twilioTokenInput.value = localStorage.getItem("twilio_token");
  }
  if (localStorage.getItem("from_number")) {
    fromNumberInput.value = localStorage.getItem("from_number");
  }
  if (localStorage.getItem("to_number")) {
    toNumberInput.value = localStorage.getItem("to_number");
  }
}

// Save credentials to local storage
function saveCredentialsToCache() {
  localStorage.setItem("elevenlabs_key", elevenlabsKeyInput.value);
  localStorage.setItem("twilio_sid", twilioSidInput.value);
  localStorage.setItem("twilio_token", twilioTokenInput.value);
  localStorage.setItem("from_number", fromNumberInput.value);
  localStorage.setItem("to_number", toNumberInput.value);
}

// Fetch available voices from backend
async function refreshVoicesList() {
  const apiKey = elevenlabsKeyInput.value.trim();
  
  voiceSelect.innerHTML = `<option value="" disabled selected>Loading voices...</option>`;
  
  try {
    const headers = {};
    if (apiKey) {
      headers["x-elevenlabs-api-key"] = apiKey;
    }

    const response = await fetch("/api/voices", { headers });
    if (!response.ok) {
      throw new Error(`Failed to load voices: ${response.status}`);
    }
    
    const voices = await response.json();
    voiceSelect.innerHTML = "";
    
    voices.forEach(voice => {
      const option = document.createElement("option");
      option.value = voice.id;
      // Truncate category if needed
      option.textContent = `${voice.name} (${voice.category})`;
      
      // Default to "Rachel" or "Adam" premade voice if found, or first voice
      if (voice.name.toLowerCase() === "adam" || voice.name.toLowerCase() === "rachel") {
        option.selected = true;
      }
      voiceSelect.appendChild(option);
    });

    logMessage(`Loaded ${voices.length} voices successfully.`, "success");
  } catch (error) {
    console.error(error);
    logMessage("Error loading voice list. Check your ElevenLabs key.", "error");
    voiceSelect.innerHTML = `<option value="" disabled selected>Error loading voices</option>`;
  }
}

// Connect Browser client WebSocket to server
function connectBrowserWs() {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const wsUrl = `${protocol}//${window.location.host}/browser-stream`;
  
  logMessage(`Connecting browser WebSocket to ${wsUrl}...`);
  
  activeBrowserWs = new WebSocket(wsUrl);
  
  activeBrowserWs.onopen = () => {
    logMessage("Browser WebSocket connected to server.", "success");
  };
  
  activeBrowserWs.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    
    if (msg.type === "status") {
      updateCallStatus(msg.status);
    } 
    else if (msg.type === "tunnel") {
      tunnelUrlSpan.textContent = msg.url;
      tunnelUrlSpan.classList.add("connected");
      logMessage(`Tunnel URL established: ${msg.url}`, "success");
    }
    else if (msg.type === "audio") {
      // Receive audio payload (base64 ulaw) from Twilio recipient and play it
      playRecipientAudio(msg.payload);
    }
  };
  
  activeBrowserWs.onerror = (err) => {
    console.error("Browser WebSocket error:", err);
    logMessage("Browser WebSocket error occurred.", "error");
  };
  
  activeBrowserWs.onclose = () => {
    logMessage("Browser WebSocket disconnected. Reconnecting in 3 seconds...", "warning");
    setTimeout(connectBrowserWs, 3000);
  };
}

// Update UI call status badge
function updateCallStatus(status) {
  appStatusBadge.className = "status-badge";
  appStatusBadge.classList.add(status);
  appStatusLabel.textContent = status.toUpperCase();
  
  if (status === "connected") {
    isCallActive = true;
    logMessage("Call connected! Audio stream active.", "success");
    btnCall.disabled = true;
    btnHangUp.disabled = false;
    btnMute.disabled = false;
    
    // Start microphone recording and streaming
    startMicStream();
  } 
  else if (status === "ended" || status === "idle") {
    if (isCallActive) {
      logMessage("Call ended.", "info");
    }
    isCallActive = false;
    callSid = null;
    streamSid = null;
    
    btnCall.disabled = false;
    btnHangUp.disabled = true;
    btnMute.disabled = true;
    btnMute.classList.remove("muted-mic");
    btnMute.classList.add("active-mic");
    muteIcon.textContent = "🎙️";
    btnMute.querySelector("span:not(.icon)").textContent = "Mic Active";
    isMuted = false;
    
    stopMicStream();
  } 
  else if (status === "calling") {
    logMessage("Initiating Twilio call. Waiting for answer...");
    btnCall.disabled = true;
    btnHangUp.disabled = false;
  }
}

// Save settings to the server (.env file)
async function saveSettingsToServer() {
  saveCredentialsToCache();
  try {
    const response = await fetch("/api/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        elevenlabsApiKey: elevenlabsKeyInput.value.trim(),
        twilioAccountSid: twilioSidInput.value.trim(),
        twilioAuthToken: twilioTokenInput.value.trim(),
        twilioPhoneNumber: fromNumberInput.value.trim()
      })
    });
    
    if (response.ok) {
      logMessage("Credentials locked in on server (.env).", "success");
    }
  } catch (err) {
    console.error("Error saving settings to server:", err);
    logMessage("Failed to save credentials to server.", "error");
  }
}

// Event Listeners setup
function setupEventListeners() {
  btnRefreshVoices.addEventListener("click", () => {
    logMessage("Refreshing voice list...");
    refreshVoicesList();
  });

  elevenlabsKeyInput.addEventListener("change", () => {
    saveSettingsToServer();
    refreshVoicesList();
  });

  twilioSidInput.addEventListener("change", saveSettingsToServer);
  twilioTokenInput.addEventListener("change", saveSettingsToServer);
  fromNumberInput.addEventListener("change", saveSettingsToServer);
  
  toNumberInput.addEventListener("change", () => {
    saveCredentialsToCache();
  });

  btnClearLogs.addEventListener("click", () => {
    logsConsole.innerHTML = '<div class="log-line system">[System] Console cleared.</div>';
  });

  btnCall.addEventListener("click", makeCall);
  btnHangUp.addEventListener("click", hangUpCall);
  btnMute.addEventListener("click", toggleMute);
}

// Start Twilio Call
async function makeCall() {
  const to = toNumberInput.value.trim();
  const from = fromNumberInput.value.trim();
  const twilioAccountSid = twilioSidInput.value.trim();
  const twilioAuthToken = twilioTokenInput.value.trim();

  if (!to) {
    alert("Please enter a recipient phone number.");
    return;
  }

  saveCredentialsToCache();
  updateCallStatus("calling");

  try {
    const response = await fetch("/api/make-call", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        to,
        from,
        twilioAccountSid,
        twilioAuthToken
      })
    });

    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || "Failed to make call.");
    }

    callSid = data.callSid;
    logMessage(`Twilio Call created. SID: ${callSid}`, "success");
  } catch (error) {
    logMessage(`Call failed: ${error.message}`, "error");
    updateCallStatus("idle");
  }
}

// Hangup Twilio Call
async function hangUpCall() {
  if (!callSid) {
    // If we don't have callSid but we think call is active, just reset status
    updateCallStatus("idle");
    return;
  }

  logMessage("Hanging up call...");
  const twilioAccountSid = twilioSidInput.value.trim();
  const twilioAuthToken = twilioTokenInput.value.trim();

  try {
    const response = await fetch("/api/hang-up", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        callSid,
        twilioAccountSid,
        twilioAuthToken
      })
    });

    if (!response.ok) {
      const data = await response.json();
      throw new Error(data.error || "Failed to hang up.");
    }

    logMessage("Call terminated successfully.", "success");
    updateCallStatus("idle");
  } catch (error) {
    logMessage(`Error hanging up: ${error.message}`, "error");
    updateCallStatus("idle");
  }
}

// Microphone Mute toggle
function toggleMute() {
  isMuted = !isMuted;
  
  if (isMuted) {
    btnMute.classList.remove("active-mic");
    btnMute.classList.add("muted-mic");
    muteIcon.textContent = "🔇";
    btnMute.querySelector("span:not(.icon)").textContent = "Mic Muted";
    logMessage("Microphone muted.", "warning");
  } else {
    btnMute.classList.remove("muted-mic");
    btnMute.classList.add("active-mic");
    muteIcon.textContent = "🎙️";
    btnMute.querySelector("span:not(.icon)").textContent = "Mic Active";
    logMessage("Microphone unmuted.", "info");
  }
}

// Web Audio API & Media Capture (Voice Changer)
async function startMicStream() {
  // Ensure AudioContext is initialized
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
  if (audioCtx.state === "suspended") {
    await audioCtx.resume();
  }

  // Setup Analysers
  if (!micAnalyser) {
    micAnalyser = audioCtx.createAnalyser();
    micAnalyser.fftSize = 256;
  }
  if (!recipientAnalyser) {
    recipientAnalyser = audioCtx.createAnalyser();
    recipientAnalyser.fftSize = 256;
  }

  try {
    micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    
    // Connect microphone node to analyser (only for visualizer, we don't play it to speaker!)
    micSourceNode = audioCtx.createMediaStreamSource(micStream);
    micSourceNode.connect(micAnalyser);
    
    logMessage("Microphone access granted. Starting live voice changer...");
    
    // Start continuous chunk recording
    recordAudioChunk();
  } catch (err) {
    console.error(err);
    logMessage("Could not access microphone: " + err.message, "error");
  }
}

function stopMicStream() {
  if (chunkTimeout) {
    clearTimeout(chunkTimeout);
    chunkTimeout = null;
  }
  if (mediaRecorder && mediaRecorder.state !== "inactive") {
    mediaRecorder.stop();
  }
  if (micStream) {
    micStream.getTracks().forEach(track => track.stop());
    micStream = null;
  }
}

// Capture and process a 1.5s audio chunk
function recordAudioChunk() {
  if (!isCallActive || !micStream) return;

  const chunks = [];
  
  // Choose standard supported mimeType
  let options = { mimeType: "audio/webm;codecs=opus" };
  if (!MediaRecorder.isTypeSupported(options.mimeType)) {
    options = { mimeType: "audio/webm" };
  }
  if (!MediaRecorder.isTypeSupported(options.mimeType)) {
    options = { mimeType: "" }; // default
  }

  mediaRecorder = new MediaRecorder(micStream, options);

  mediaRecorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) {
      chunks.push(e.data);
    }
  };

  mediaRecorder.onstop = async () => {
    // Spawn next recording loop instantly to minimize gaps
    if (isCallActive) {
      recordAudioChunk();
    }

    // If muted, discard chunk and don't send to ElevenLabs
    if (isMuted) {
      return;
    }

    const audioBlob = new Blob(chunks, { type: "audio/webm" });
    
    if (audioBlob.size < 1000) {
      // Too small, ignore
      return;
    }

    const voiceId = voiceSelect.value;
    const elevenlabsApiKey = elevenlabsKeyInput.value.trim();

    const formData = new FormData();
    formData.append("audio", audioBlob, "chunk.webm");
    formData.append("voiceId", voiceId);
    if (elevenlabsApiKey) {
      formData.append("elevenlabsApiKey", elevenlabsApiKey);
    }

    try {
      const response = await fetch("/api/speech-to-speech", {
        method: "POST",
        body: formData
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error("Speech-to-speech error:", errorText);
      }
    } catch (err) {
      console.error("Failed to upload audio chunk:", err);
    }
  };

  mediaRecorder.start();

  // Stop recording chunk after 1.5 seconds, triggering onstop and spawning next loop
  chunkTimeout = setTimeout(() => {
    if (mediaRecorder && mediaRecorder.state === "recording") {
      mediaRecorder.stop();
    }
  }, 1500);
}

// U-law to Linear PCM conversion helper
// Telephony audio (u-law) is 8-bit log compressed.
function ulawToPcm(ulawByte) {
  ulawByte = ~ulawByte;
  let sign = (ulawByte & 0x80) ? -1 : 1;
  let exponent = (ulawByte >> 4) & 0x07;
  let mantissa = ulawByte & 0x0F;
  let sample = (mantissa << 3) + 132;
  sample <<= exponent;
  sample -= 132;
  return sign * sample / 32768.0;
}

// Decode and play received audio (from the called party)
async function playRecipientAudio(base64Payload) {
  if (!audioCtx) return;

  try {
    // Decode base64 to binary byte array (u-law format)
    const binaryString = atob(base64Payload);
    const len = binaryString.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }

    // Convert u-law bytes to Float32 PCM
    const pcmData = new Float32Array(len);
    for (let i = 0; i < len; i++) {
      pcmData[i] = ulawToPcm(bytes[i]);
    }

    // Create AudioBuffer: 8000Hz sample rate, 1 channel (matching Twilio)
    const audioBuffer = audioCtx.createBuffer(1, len, 8000);
    audioBuffer.copyToChannel(pcmData, 0);

    // Play the buffer
    const source = audioCtx.createBufferSource();
    source.buffer = audioBuffer;

    // Connect node to analyser (for viz) and speaker destination
    source.connect(recipientAnalyser);
    recipientAnalyser.connect(audioCtx.destination);

    source.start();
  } catch (err) {
    console.error("Error playing recipient audio:", err);
  }
}

// Visualizer oscilloscope drawing
function initVisualizer() {
  const canvasCtx = visualizerCanvas.getContext("2d");
  
  // Set logical resolution matching visual layout
  function resizeCanvas() {
    visualizerCanvas.width = visualizerCanvas.clientWidth * window.devicePixelRatio;
    visualizerCanvas.height = visualizerCanvas.clientHeight * window.devicePixelRatio;
    canvasCtx.scale(window.devicePixelRatio, window.devicePixelRatio);
  }
  
  resizeCanvas();
  window.addEventListener("resize", resizeCanvas);

  function draw() {
    requestAnimationFrame(draw);

    const width = visualizerCanvas.width / window.devicePixelRatio;
    const height = visualizerCanvas.height / window.devicePixelRatio;

    // Background clear
    canvasCtx.fillStyle = "rgba(7, 10, 22, 0.4)";
    canvasCtx.fillRect(0, 0, width, height);

    // Draw center line
    canvasCtx.strokeStyle = "rgba(56, 68, 107, 0.2)";
    canvasCtx.lineWidth = 1;
    canvasCtx.beginPath();
    canvasCtx.moveTo(0, height / 2);
    canvasCtx.lineTo(width, height / 2);
    canvasCtx.stroke();

    // 1. Draw Mic Waveform (Cyan)
    if (micAnalyser && isCallActive && !isMuted) {
      const bufferLength = micAnalyser.frequencyBinCount;
      const dataArray = new Uint8Array(bufferLength);
      micAnalyser.getByteTimeDomainData(dataArray);

      canvasCtx.strokeStyle = "#00e5ff"; // Neon Cyan
      canvasCtx.lineWidth = 2.5;
      canvasCtx.shadowBlur = 8;
      canvasCtx.shadowColor = "#00e5ff";
      canvasCtx.beginPath();

      const sliceWidth = width / bufferLength;
      let x = 0;

      for (let i = 0; i < bufferLength; i++) {
        const v = dataArray[i] / 128.0;
        const y = (v * height) / 2;

        if (i === 0) {
          canvasCtx.moveTo(x, y);
        } else {
          canvasCtx.lineTo(x, y);
        }

        x += sliceWidth;
      }
      canvasCtx.lineTo(width, height / 2);
      canvasCtx.stroke();
    }

    // Reset shadow blur
    canvasCtx.shadowBlur = 0;

    // 2. Draw Recipient Waveform (Emerald Green)
    if (recipientAnalyser && isCallActive) {
      const bufferLength = recipientAnalyser.frequencyBinCount;
      const dataArray = new Uint8Array(bufferLength);
      recipientAnalyser.getByteTimeDomainData(dataArray);

      canvasCtx.strokeStyle = "#00e676"; // Neon Green
      canvasCtx.lineWidth = 2.5;
      canvasCtx.shadowBlur = 8;
      canvasCtx.shadowColor = "#00e676";
      canvasCtx.beginPath();

      const sliceWidth = width / bufferLength;
      let x = 0;

      for (let i = 0; i < bufferLength; i++) {
        const v = dataArray[i] / 128.0;
        const y = (v * height) / 2;

        if (i === 0) {
          canvasCtx.moveTo(x, y);
        } else {
          canvasCtx.lineTo(x, y);
        }

        x += sliceWidth;
      }
      canvasCtx.lineTo(width, height / 2);
      canvasCtx.stroke();
    }

    // Reset shadow blur for clean canvas clear on next frame
    canvasCtx.shadowBlur = 0;
  }

  draw();
}
