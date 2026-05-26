import express from "express";
import http from "http";
import { WebSocketServer } from "ws";
import dotenv from "dotenv";
import multer from "multer";
import path from "path";
import { fileURLToPath } from "url";
import { spawn } from "child_process";
import fs from "fs";

// Load environment variables
dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

// Setup multer for in-memory audio chunk uploads
const upload = multer({ storage: multer.memoryStorage() });

app.use(express.json());

// Enable CORS for all routes (necessary when Flutter Web runs on a different port)
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept, Authorization, x-elevenlabs-api-key");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS, PUT, DELETE");
  if (req.method === "OPTIONS") {
    return res.sendStatus(200);
  }
  next();
});

app.use(express.static(path.join(__dirname, "public")));

// State variables for active call
let activeTwilioWs = null;
let activeBrowserWs = null;
let activeStreamSid = null;

// Expose public URL storage (will be set by tunnel)
let publicUrl = "";

// Function to update keys inside the .env file automatically
function updateEnvFile(updates) {
  try {
    const envPath = path.join(__dirname, ".env");
    let envContent = "";
    if (fs.existsSync(envPath)) {
      envContent = fs.readFileSync(envPath, "utf8");
    }

    let modified = false;
    for (const [key, value] of Object.entries(updates)) {
      if (value === undefined) continue;
      
      const regex = new RegExp(`^${key}=.*$`, "m");
      const match = envContent.match(regex);
      
      if (match) {
        const currentValue = match[0].split("=")[1];
        if (currentValue !== value) {
          envContent = envContent.replace(regex, `${key}=${value}`);
          modified = true;
        }
      } else {
        envContent += `\n${key}=${value}`;
        modified = true;
      }
    }

    if (modified) {
      fs.writeFileSync(envPath, envContent.trim() + "\n", "utf8");
      console.log(`[Server] Config updated in .env file:`, Object.keys(updates));
      // Reload environment variables in running process
      dotenv.config();
    }
  } catch (err) {
    console.error("[Server] Error writing to .env file:", err.message);
  }
}

// Endpoint to update or get the current public tunnel URL
app.post("/api/tunnel-url", (req, res) => {
  const { url } = req.body;
  if (url) {
    publicUrl = url.replace("http://", "https://");
    console.log(`[Tunnel] Public URL updated to: ${publicUrl}`);
  }
  res.json({ success: true, publicUrl });
});

app.get("/api/tunnel-url", (req, res) => {
  res.json({ publicUrl });
});

// Endpoint to get active server settings (from .env)
app.get("/api/settings", (req, res) => {
  res.json({
    elevenlabsApiKey: process.env.ELEVENLABS_API_KEY || "",
    twilioAccountSid: process.env.TWILIO_ACCOUNT_SID || "",
    twilioAuthToken: process.env.TWILIO_AUTH_TOKEN || "",
    twilioPhoneNumber: process.env.TWILIO_PHONE_NUMBER || ""
  });
});

// Endpoint to update server settings in .env
app.post("/api/settings", (req, res) => {
  const { elevenlabsApiKey, twilioAccountSid, twilioAuthToken, twilioPhoneNumber } = req.body;
  
  const updates = {};
  if (elevenlabsApiKey !== undefined) updates.ELEVENLABS_API_KEY = elevenlabsApiKey;
  if (twilioAccountSid !== undefined) updates.TWILIO_ACCOUNT_SID = twilioAccountSid;
  if (twilioAuthToken !== undefined) updates.TWILIO_AUTH_TOKEN = twilioAuthToken;
  if (twilioPhoneNumber !== undefined) updates.TWILIO_PHONE_NUMBER = twilioPhoneNumber;

  updateEnvFile(updates);
  res.json({ success: true });
});

// Endpoint to list ElevenLabs voices
app.get("/api/voices", async (req, res) => {
  const apiKey = req.headers["x-elevenlabs-api-key"] || process.env.ELEVENLABS_API_KEY;

  if (!apiKey) {
    // Return a default fallback list of popular ElevenLabs voices if no API key is provided yet
    return res.json([
      { id: "21m00Tcm4TlvDq8ikWAM", name: "Rachel", category: "premade" },
      { id: "AZnzlk1XhkO0tGdJctGE", name: "Domi", category: "premade" },
      { id: "EXAVITQu4vr4xnSDxMaL", name: "Bella", category: "premade" },
      { id: "ErXwobaYiN019PkySvjV", name: "Antoni", category: "premade" },
      { id: "MF3mGyEYCl7XYWbV9VbO", name: "Elli", category: "premade" },
      { id: "TxGEqn7nUa5To4ti6g8G", name: "Josh", category: "premade" },
      { id: "VR6A1rx1a6eOr4t62p1a", name: "Arnold", category: "premade" },
      { id: "pNInz6obpgHsBi2QP1gk", name: "Adam", category: "premade" }
    ]);
  }

  try {
    const response = await fetch("https://api.elevenlabs.io/v1/voices", {
      headers: { "xi-api-key": apiKey }
    });
    
    if (!response.ok) {
      throw new Error(`ElevenLabs API responded with status ${response.status}`);
    }

    // Save key if it was sent in header and succeeded
    if (req.headers["x-elevenlabs-api-key"]) {
      updateEnvFile({ ELEVENLABS_API_KEY: req.headers["x-elevenlabs-api-key"] });
    }

    const data = await response.json();
    const formattedVoices = data.voices.map(v => ({
      id: v.voice_id,
      name: v.name,
      category: v.category
    }));

    res.json(formattedVoices);
  } catch (error) {
    console.error("[ElevenLabs] Error fetching voices:", error.message);
    res.status(500).json({ error: "Failed to fetch voices from ElevenLabs" });
  }
});

// Endpoint to initiate the Twilio Outbound Call
app.post("/api/make-call", async (req, res) => {
  const { to, from, twilioAccountSid, twilioAuthToken } = req.body;

  const accountSid = twilioAccountSid || process.env.TWILIO_ACCOUNT_SID;
  const authToken = twilioAuthToken || process.env.TWILIO_AUTH_TOKEN;
  const callerId = from || process.env.TWILIO_PHONE_NUMBER || "+18669423712";

  if (!accountSid || !authToken) {
    return res.status(400).json({ error: "Twilio Account SID and Auth Token are required." });
  }
  if (!to) {
    return res.status(400).json({ error: "Recipient phone number (To) is required." });
  }
  if (!publicUrl) {
    return res.status(400).json({ error: "Public tunnel URL is not set yet. Please start the tunnel." });
  }

  const tunnelHost = publicUrl.replace("https://", "").replace("http://", "");
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="wss://${tunnelHost}/twilio-stream" />
  </Connect>
</Response>`;

  console.log(`[Twilio] Initiating outbound call from ${callerId} to ${to}`);
  console.log(`[Twilio] Connecting to WebSocket Stream: wss://${tunnelHost}/twilio-stream`);

  try {
    const url = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Calls.json`;
    const authString = Buffer.from(`${accountSid}:${authToken}`).toString("base64");

    const params = new URLSearchParams();
    params.append("To", to);
    params.append("From", callerId);
    params.append("Twiml", twiml);

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": `Basic ${authString}`,
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: params
    });

    const data = await response.json();

    if (!response.ok) {
      console.error("[Twilio] Call creation failed:", data);
      return res.status(response.status).json({ error: data.message || "Failed to make call." });
    }

    // Save Twilio credentials if they were sent in body and call succeeded
    if (twilioAccountSid || twilioAuthToken) {
      updateEnvFile({
        TWILIO_ACCOUNT_SID: twilioAccountSid,
        TWILIO_AUTH_TOKEN: twilioAuthToken,
        TWILIO_PHONE_NUMBER: callerId
      });
    }

    res.json({ success: true, callSid: data.sid, status: data.status });
  } catch (error) {
    console.error("[Twilio] Error creating call:", error.message);
    res.status(500).json({ error: error.message });
  }
});

// Endpoint to hang up the call
app.post("/api/hang-up", async (req, res) => {
  const { callSid, twilioAccountSid, twilioAuthToken } = req.body;
  const accountSid = twilioAccountSid || process.env.TWILIO_ACCOUNT_SID;
  const authToken = twilioAuthToken || process.env.TWILIO_AUTH_TOKEN;

  if (!accountSid || !authToken) {
    return res.status(400).json({ error: "Twilio Account SID and Auth Token are required." });
  }
  if (!callSid) {
    return res.status(400).json({ error: "Call SID is required." });
  }

  console.log(`[Twilio] Terminating call: ${callSid}`);
  try {
    const url = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Calls/${callSid}.json`;
    const authString = Buffer.from(`${accountSid}:${authToken}`).toString("base64");

    const params = new URLSearchParams();
    params.append("Status", "completed");

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": `Basic ${authString}`,
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: params
    });

    const data = await response.json();
    if (!response.ok) {
      console.error("[Twilio] Hangup failed:", data);
      return res.status(response.status).json({ error: data.message || "Failed to hang up call." });
    }

    cleanupCall();
    res.json({ success: true });
  } catch (error) {
    console.error("[Twilio] Error hanging up call:", error.message);
    res.status(500).json({ error: error.message });
  }
});

// Endpoint to handle incoming microphone audio from browser, transform it via ElevenLabs STS, and send to Twilio
app.post("/api/speech-to-speech", upload.single("audio"), async (req, res) => {
  const { voiceId, elevenlabsApiKey } = req.body;
  const apiKey = elevenlabsApiKey || process.env.ELEVENLABS_API_KEY;

  if (!apiKey) {
    return res.status(400).json({ error: "ElevenLabs API Key is required." });
  }
  if (!voiceId) {
    return res.status(400).json({ error: "Voice ID is required." });
  }
  if (!req.file) {
    return res.status(400).json({ error: "No audio file provided." });
  }

  // If there is no active call, we can't play it, but we can return success (e.g. for testing)
  if (!activeTwilioWs || !activeStreamSid) {
    console.log("[ElevenLabs] STS request received but no active Twilio call is connected.");
    return res.json({ success: true, message: "No active Twilio call" });
  }

  try {
    console.log(`[ElevenLabs] Sending audio chunk (${req.file.size} bytes) for voice conversion to ID: ${voiceId}`);
    
    // Prepare multipart form data for ElevenLabs Speech-to-Speech API
    const formData = new FormData();
    const audioBlob = new Blob([req.file.buffer], { type: "audio/webm" });
    formData.append("audio", audioBlob, "chunk.webm");
    formData.append("model_id", "eleven_english_sts_v2");
    
    // Request output format in ulaw_8000 (standard Twilio telephony format)
    const stsUrl = `https://api.elevenlabs.io/v1/speech-to-speech/${voiceId}?output_format=ulaw_8000`;
    
    const response = await fetch(stsUrl, {
      method: "POST",
      headers: {
        "xi-api-key": apiKey
      },
      body: formData
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error("[ElevenLabs] STS API Error:", errorText);
      return res.status(response.status).json({ error: `ElevenLabs STS failed: ${errorText}` });
    }

    // Save key if it was sent in body and succeeded
    if (elevenlabsApiKey) {
      updateEnvFile({ ELEVENLABS_API_KEY: elevenlabsApiKey });
    }

    const arrayBuffer = await response.arrayBuffer();
    const ulawBuffer = Buffer.from(arrayBuffer);
    console.log(`[ElevenLabs] Received voice-changed audio (${ulawBuffer.length} bytes, u-law)`);

    // Stream the audio back to Twilio
    const base64Payload = ulawBuffer.toString("base64");

    activeTwilioWs.send(JSON.stringify({
      event: "media",
      streamSid: activeStreamSid,
      media: {
        payload: base64Payload
      }
    }));

    res.json({ success: true });
  } catch (error) {
    console.error("[ElevenLabs] Error in speech-to-speech processing:", error.message);
    res.status(500).json({ error: error.message });
  }
});

// Handle WebSocket connections
server.on("upgrade", (request, socket, head) => {
  const pathname = new URL(request.url, `http://${request.headers.host}`).pathname;

  if (pathname === "/twilio-stream" || pathname === "/browser-stream") {
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit("connection", ws, request);
    });
  } else {
    socket.destroy();
  }
});

wss.on("connection", (ws, request) => {
  const pathname = new URL(request.url, `http://${request.headers.host}`).pathname;

  if (pathname === "/twilio-stream") {
    console.log("[WebSocket] Twilio Media Stream connected.");
    activeTwilioWs = ws;

    ws.on("message", (message) => {
      try {
        const msg = JSON.parse(message);

        if (msg.event === "start") {
          activeStreamSid = msg.start.streamSid;
          console.log(`[WebSocket] Twilio Stream started. Stream SID: ${activeStreamSid}`);
          
          if (activeBrowserWs && activeBrowserWs.readyState === 1) {
            activeBrowserWs.send(JSON.stringify({ type: "status", status: "connected", streamSid: activeStreamSid }));
          }
        } 
        else if (msg.event === "media") {
          // This is the called party speaking. Forward their voice to the browser.
          if (msg.media.track === "inbound") {
            if (activeBrowserWs && activeBrowserWs.readyState === 1) {
              activeBrowserWs.send(JSON.stringify({
                type: "audio",
                payload: msg.media.payload // base64-encoded u-law audio
              }));
            }
          }
        } 
        else if (msg.event === "stop") {
          console.log("[WebSocket] Twilio Stream stopped.");
          cleanupCall();
        }
      } catch (err) {
        console.error("[WebSocket] Error processing Twilio message:", err.message);
      }
    });

    ws.on("close", () => {
      console.log("[WebSocket] Twilio connection closed.");
      cleanupCall();
    });

  } else if (pathname === "/browser-stream") {
    console.log("[WebSocket] Browser client connected.");
    activeBrowserWs = ws;

    // Send connection status
    ws.send(JSON.stringify({ 
      type: "status", 
      status: activeTwilioWs ? "connected" : "idle",
      streamSid: activeStreamSid 
    }));

    if (publicUrl) {
      ws.send(JSON.stringify({ type: "tunnel", url: publicUrl }));
    }

    ws.on("close", () => {
      console.log("[WebSocket] Browser connection closed.");
      if (activeBrowserWs === ws) {
        activeBrowserWs = null;
      }
    });
  }
});

function cleanupCall() {
  activeStreamSid = null;
  activeTwilioWs = null;
  if (activeBrowserWs && activeBrowserWs.readyState === 1) {
    activeBrowserWs.send(JSON.stringify({ type: "status", status: "ended" }));
  }
}

// Start server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`[Server] Live Voice Changer app running on http://localhost:${PORT}`);
  startTunnel();
});

let activeTunnelProcess = null;

function startTunnel() {
  console.log("[Tunnel] Starting SSH secure tunnel (localhost.run) in the background...");
  try {
    if (activeTunnelProcess) {
      activeTunnelProcess.kill();
    }

    const tunnel = spawn("ssh", [
      "-o", "StrictHostKeyChecking=no",
      "-R", `80:localhost:${PORT}`,
      "nokey@localhost.run"
    ]);

    activeTunnelProcess = tunnel;

    tunnel.stdout.on("data", (data) => {
      const output = data.toString();
      // Match the localhost.run URL pattern (could be lhr.life, lhr.rocks, or localhost.run)
      const match = output.match(/https?:\/\/[a-zA-Z0-9.-]+\.(lhr\.life|lhr\.rocks|localhost\.run)/);
      if (match) {
        publicUrl = match[0].replace("http://", "https://");
        console.log(`\n==================================================`);
        console.log(`[Tunnel] Public URL established: ${publicUrl}`);
        console.log(`==================================================\n`);
        
        // Notify browser if already connected
        if (activeBrowserWs && activeBrowserWs.readyState === 1) {
          activeBrowserWs.send(JSON.stringify({ type: "tunnel", url: publicUrl }));
        }
      }
    });

    tunnel.stderr.on("data", (data) => {
      const errOutput = data.toString().trim();
      if (errOutput.toLowerCase().includes("error") || errOutput.toLowerCase().includes("failed")) {
        console.warn(`[Tunnel Warning] ${errOutput}`);
      }
    });

    tunnel.on("close", (code) => {
      console.log(`[Tunnel] SSH Tunnel process closed with code ${code}. Reconnecting in 5 seconds...`);
      publicUrl = "";
      if (activeBrowserWs && activeBrowserWs.readyState === 1) {
        activeBrowserWs.send(JSON.stringify({ type: "tunnel", url: "" }));
      }
      activeTunnelProcess = null;
      setTimeout(startTunnel, 5000);
    });

  } catch (err) {
    console.error("[Tunnel] Failed to start SSH tunnel:", err.message);
    setTimeout(startTunnel, 5000);
  }
}

process.on("exit", () => {
  if (activeTunnelProcess) {
    activeTunnelProcess.kill();
  }
});
