import 'dart:async';
import 'dart:convert';
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;
import 'package:web_socket_channel/web_socket_channel.dart';
import 'package:record/record.dart';
import 'package:audioplayers/audioplayers.dart';

// True when running under flutter_test (set by the test runner via --dart-define)
const bool isTesting = bool.fromEnvironment('FLUTTER_TEST');

void main() {
  runApp(const VoiceChangerApp());
}

class VoiceChangerApp extends StatelessWidget {
  const VoiceChangerApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'Live Voice Changer Call Panel',
      debugShowCheckedModeBanner: false,
      theme: ThemeData.dark().copyWith(
        scaffoldBackgroundColor: const Color(0xFF090B11),
        colorScheme: const ColorScheme.dark().copyWith(
          primary: const Color(0xFF00F2FE),
          secondary: const Color(0xFF00E676),
          surface: const Color(0xFF121629),
          error: const Color(0xFFFF1744),
        ),
        cardTheme: CardThemeData(
          color: const Color(0xFF121629).withValues(alpha: 0.75),
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(16),
            side: BorderSide(
              color: const Color(0xFF38446B).withValues(alpha: 0.4),
              width: 1,
            ),
          ),
          elevation: 8,
        ),
        inputDecorationTheme: InputDecorationTheme(
          fillColor: const Color(0xFF0E1224).withValues(alpha: 0.8),
          filled: true,
          labelStyle: const TextStyle(color: Color(0xFF8C9BB4)),
          enabledBorder: OutlineInputBorder(
            borderRadius: BorderRadius.circular(8),
            borderSide: BorderSide(
              color: const Color(0xFF38446B).withValues(alpha: 0.4),
            ),
          ),
          focusedBorder: OutlineInputBorder(
            borderRadius: BorderRadius.circular(8),
            borderSide: const BorderSide(color: Color(0xFF00F2FE)),
          ),
        ),
      ),
      home: const ControlPanelScreen(),
    );
  }
}

class ControlPanelScreen extends StatefulWidget {
  const ControlPanelScreen({super.key});

  @override
  State<ControlPanelScreen> createState() => _ControlPanelScreenState();
}

class _ControlPanelScreenState extends State<ControlPanelScreen> {
  // Text Controllers
  final _serverUrlController = TextEditingController(text: 'http://localhost:3005');
  final _fromNumberController = TextEditingController(text: '+18669423712');
  final _toNumberController = TextEditingController();

  // State Variables
  String _callStatus = 'IDLE'; // IDLE, CALLING, CONNECTED, ENDED
  String? _callSid;
  bool _isMuted = false;
  List<Map<String, dynamic>> _voices = [];
  String? _selectedVoiceId;
  final List<String> _logs = [];

  // WebSockets and Audio
  WebSocketChannel? _wsChannel;
  final AudioPlayer _audioPlayer = AudioPlayer();
  final AudioRecorder _recorder = AudioRecorder();
  
  // Stream-based recorder state
  bool _isRecordingChunks = false;
  StreamSubscription<Uint8List>? _micStreamSub;
  List<int> _pcmBuffer = [];
  Timer? _chunkTimer;

  @override
  void initState() {
    super.initState();
    _log('Application loaded. Ready to configure parameters.');
    if (!isTesting) {
      _connectWebSocket();
      _loadVoices();
    }
  }

  @override
  void dispose() {
    _wsChannel?.sink.close();
    _audioPlayer.dispose();
    _recorder.dispose();
    _micStreamSub?.cancel();
    _chunkTimer?.cancel();
    _serverUrlController.dispose();
    _fromNumberController.dispose();
    _toNumberController.dispose();
    super.dispose();
  }

  // Logs helper
  void _log(String text, {String type = 'system'}) {
    final timestamp = DateTime.now().toLocal().toString().split(' ')[1].substring(0, 8);
    if (mounted) {
      setState(() {
        _logs.add('[$timestamp] $text');
      });
    } else {
      debugPrint('[$timestamp] $text');
    }
  }

  // Fetch voices list from server
  Future<void> _loadVoices() async {
    if (isTesting) return;
    final serverUrl = _serverUrlController.text.trim();
    if (serverUrl.isEmpty) return;

    if (mounted) {
      setState(() {
        _voices = [];
        _selectedVoiceId = null;
      });
    }

    try {
      final response = await http.get(Uri.parse('$serverUrl/api/voices'));
      if (response.statusCode == 200) {
        final List<dynamic> data = jsonDecode(response.body);
        if (!mounted) return;
        setState(() {
          _voices = data.map((v) => {
            'id': v['id'],
            'name': v['name'],
            'category': v['category'],
          }).toList();
          
          if (_voices.isNotEmpty) {
            // Default to Rachel/Adam if found
            final defaultVoice = _voices.firstWhere(
              (v) => v['name'].toString().toLowerCase() == 'rachel' || v['name'].toString().toLowerCase() == 'adam',
              orElse: () => _voices.first,
            );
            _selectedVoiceId = defaultVoice['id'];
          }
        });
        _log('Loaded ${_voices.length} voices successfully.', type: 'success');
      } else {
        throw Exception('Server returned ${response.statusCode}');
      }
    } catch (e) {
      _log('Error loading voices: $e', type: 'error');
    }
  }

  // Connect to the server WebSocket for incoming called-party audio and status updates
  void _connectWebSocket() {
    if (isTesting) return;
    final serverUrl = _serverUrlController.text.trim();
    if (serverUrl.isEmpty) return;

    _wsChannel?.sink.close();

    final wsUriString = serverUrl.replaceFirst('https://', 'wss://').replaceFirst('http://', 'ws://');
    final wsUrl = '$wsUriString/browser-stream';

    _log('Connecting WebSocket to $wsUrl...');
    
    try {
      _wsChannel = WebSocketChannel.connect(Uri.parse(wsUrl));
      
      _wsChannel!.stream.listen(
        (message) {
          if (!mounted) return;
          final data = jsonDecode(message);
          final String type = data['type'];
          
          if (type == 'status') {
            final String status = data['status'];
            _handleStatusChange(status);
          } 
          else if (type == 'audio') {
            // Received base64-encoded u-law audio from called party. Decode & Play.
            final String base64Payload = data['payload'];
            _playTelephonyAudio(base64Payload);
          }
          else if (type == 'tunnel') {
            final String url = data['url'];
            _log('Server Tunnel URL updated: $url', type: 'success');
          }
        },
        onError: (err) {
          if (!mounted) return;
          _log('WebSocket error: $err', type: 'error');
        },
        onDone: () {
          if (!mounted) return;
          _log('WebSocket connection closed.', type: 'warning');
          _handleStatusChange('ended');
        },
      );
    } catch (e) {
      _log('Failed to connect WebSocket: $e', type: 'error');
    }
  }

  // Process server status updates
  void _handleStatusChange(String status) {
    if (!mounted) return;
    setState(() {
      _callStatus = status.toUpperCase();
    });

    if (status == 'connected') {
      _log('Call connected! Audio stream active.', type: 'success');
      _startMicStream();
    } 
    else if (status == 'ended' || status == 'idle') {
      if (_callStatus != 'IDLE') {
        _log('Call ended.', type: 'info');
      }
      _callSid = null;
      _stopMicStream();
    }
  }

  // Initiate Outbound Call
  Future<void> _makeCall() async {
    final serverUrl = _serverUrlController.text.trim();
    final to = _toNumberController.text.trim();
    final from = _fromNumberController.text.trim();

    if (to.isEmpty) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('Please enter a recipient number.')),
        );
      }
      return;
    }

    _log('Initiating Twilio call. Waiting for answer...');
    if (mounted) {
      setState(() {
        _callStatus = 'CALLING';
      });
    }

    // Make sure WebSocket is connected
    _connectWebSocket();

    try {
      final response = await http.post(
        Uri.parse('$serverUrl/api/make-call'),
        headers: {'Content-Type': 'application/json'},
        body: jsonEncode({
          'to': to,
          'from': from,
        }),
      );

      final data = jsonDecode(response.body);
      if (response.statusCode == 200 && data['success'] == true) {
        if (!mounted) return;
        _callSid = data['callSid'];
        _log('Twilio Call created. SID: $_callSid', type: 'success');
      } else {
        throw Exception(data['error'] ?? 'Call failed');
      }
    } catch (e) {
      _log('Call failed: $e', type: 'error');
      _handleStatusChange('idle');
    }
  }

  // Hangup call
  Future<void> _hangUpCall() async {
    if (_callSid == null) {
      _handleStatusChange('idle');
      return;
    }

    _log('Hanging up call...');
    final serverUrl = _serverUrlController.text.trim();

    try {
      final response = await http.post(
        Uri.parse('$serverUrl/api/hang-up'),
        headers: {'Content-Type': 'application/json'},
        body: jsonEncode({'callSid': _callSid}),
      );

      if (response.statusCode == 200) {
        _log('Call terminated successfully.', type: 'success');
      } else {
        throw Exception('Server returned ${response.statusCode}');
      }
    } catch (e) {
      _log('Error hanging up: $e', type: 'error');
    } finally {
      _handleStatusChange('idle');
    }
  }

  // Toggle microphone mute state
  void _toggleMute() {
    if (mounted) {
      setState(() {
        _isMuted = !_isMuted;
      });
    }
    if (_isMuted) {
      _log('Microphone muted.', type: 'warning');
    } else {
      _log('Microphone unmuted.', type: 'info');
    }
  }

  // Start microphone chunk recording using stream API
  Future<void> _startMicStream() async {
    final hasPermission = await _recorder.hasPermission();
    if (!hasPermission) {
      _log('Microphone permission denied.', type: 'error');
      return;
    }

    _isRecordingChunks = true;
    _pcmBuffer = [];
    _log('Microphone active. Starting live voice changer...');

    try {
      final stream = await _recorder.startStream(
        const RecordConfig(
          encoder: AudioEncoder.pcm16bits,
          sampleRate: 8000,
          numChannels: 1,
        ),
      );

      _micStreamSub = stream.listen(
        (data) {
          if (_isRecordingChunks) {
            _pcmBuffer.addAll(data);
          }
        },
        onError: (e) => _log('Mic stream error: $e', type: 'error'),
      );

      // Flush buffer to server every 1.5 seconds
      _chunkTimer = Timer.periodic(const Duration(milliseconds: 1500), (_) {
        if (!_isRecordingChunks || !mounted) return;
        if (_pcmBuffer.isNotEmpty && !_isMuted) {
          final bytes = Uint8List.fromList(_pcmBuffer);
          _pcmBuffer = [];
          _uploadAudioBytes(bytes);
        } else {
          _pcmBuffer = [];
        }
      });
    } catch (e) {
      _log('Error starting mic stream: $e', type: 'error');
    }
  }

  // Stop microphone recording
  Future<void> _stopMicStream() async {
    _isRecordingChunks = false;
    _chunkTimer?.cancel();
    _chunkTimer = null;
    _micStreamSub?.cancel();
    _micStreamSub = null;
    _pcmBuffer = [];
    await _recorder.stop();
  }

  // Upload raw audio bytes to server REST API via multipart
  Future<void> _uploadAudioBytes(Uint8List bytes) async {
    final serverUrl = _serverUrlController.text.trim();
    final voiceId = _selectedVoiceId;

    if (voiceId == null) return;

    try {
      final uri = Uri.parse('$serverUrl/api/speech-to-speech');
      final request = http.MultipartRequest('POST', uri)
        ..fields['voiceId'] = voiceId
        ..files.add(http.MultipartFile.fromBytes(
          'audio',
          bytes,
          filename: 'chunk.webm',
        ));

      final response = await request.send();

      if (response.statusCode != 200) {
        _log('Voice conversion failed: ${response.statusCode}', type: 'error');
      }
    } catch (e) {
      _log('Error uploading chunk: $e', type: 'error');
    }
  }

  // Decode μ-law bytes to PCM 16-bit
  Uint8List _ulawToPcm16Bytes(Uint8List ulawBytes) {
    final pcmBytes = Uint8List(ulawBytes.length * 2);
    for (int i = 0; i < ulawBytes.length; i++) {
      int ulawByte = ulawBytes[i];
      
      // Decryption lookup
      ulawByte = ~ulawByte;
      int sign = (ulawByte & 0x80) != 0 ? -1 : 1;
      int exponent = (ulawByte >> 4) & 0x07;
      int mantissa = ulawByte & 0x0F;
      int sample = (mantissa << 3) + 132;
      sample <<= exponent;
      sample -= 132;
      int pcm16 = sign * sample;
      
      // Little Endian encoding
      pcmBytes[i * 2] = pcm16 & 0xFF;
      pcmBytes[i * 2 + 1] = (pcm16 >> 8) & 0xFF;
    }
    return pcmBytes;
  }

  // Create standard WAV container bytes around raw PCM bytes
  Uint8List _createWavContainer(Uint8List pcmBytes) {
    final int subchunk2Size = pcmBytes.length;
    final int chunkSize = 36 + subchunk2Size;
    
    final header = ByteData(44);
    
    // RIFF chunk
    header.setUint8(0, 0x52); // R
    header.setUint8(1, 0x49); // I
    header.setUint8(2, 0x46); // F
    header.setUint8(3, 0x46); // F
    header.setUint32(4, chunkSize, Endian.little);
    header.setUint8(8, 0x57); // W
    header.setUint8(9, 0x41); // A
    header.setUint8(10, 0x56); // V
    header.setUint8(11, 0x45); // E
    
    // fmt subchunk
    header.setUint8(12, 0x66); // f
    header.setUint8(13, 0x6d); // m
    header.setUint8(14, 0x74); // t
    header.setUint8(15, 0x20); // 
    header.setUint32(16, 16, Endian.little); // Subchunk1Size
    header.setUint16(20, 1, Endian.little); // AudioFormat (1 = PCM)
    header.setUint16(22, 1, Endian.little); // NumChannels (1 = Mono)
    header.setUint32(24, 8000, Endian.little); // SampleRate (8000Hz)
    header.setUint32(28, 16000, Endian.little); // ByteRate (8000 * 1 * 16 / 8)
    header.setUint16(32, 2, Endian.little); // BlockAlign (1 * 16 / 8)
    header.setUint16(34, 16, Endian.little); // BitsPerSample (16-bit)
    
    // data subchunk
    header.setUint8(36, 0x64); // d
    header.setUint8(37, 0x61); // a
    header.setUint8(38, 0x74); // t
    header.setUint8(39, 0x61); // a
    header.setUint32(40, subchunk2Size, Endian.little);
    
    final wavBytes = Uint8List(44 + subchunk2Size);
    wavBytes.setRange(0, 44, header.buffer.asUint8List());
    wavBytes.setRange(44, wavBytes.length, pcmBytes);
    return wavBytes;
  }

  // Play incoming u-law audio chunks
  Future<void> _playTelephonyAudio(String base64Payload) async {
    try {
      final ulawBytes = base64Decode(base64Payload);
      final pcmBytes = _ulawToPcm16Bytes(ulawBytes);
      final wavBytes = _createWavContainer(pcmBytes);

      // Play buffer in real time using BytesSource
      await _audioPlayer.play(BytesSource(wavBytes));
    } catch (e) {
      _log('Error playing audio: $e', type: 'error');
    }
  }

  // UI Status color helper
  Color _getStatusColor() {
    switch (_callStatus) {
      case 'CALLING':
        return Colors.amber;
      case 'CONNECTED':
        return Colors.greenAccent;
      case 'ENDED':
        return Colors.redAccent;
      default:
        return Colors.grey;
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('Live Voice Changer'),
        backgroundColor: const Color(0xFF0F1322),
        actions: [
          IconButton(
            icon: const Icon(Icons.refresh),
            onPressed: _loadVoices,
            tooltip: 'Reload Voices',
          )
        ],
      ),
      body: SingleChildScrollView(
        padding: const EdgeInsets.all(16.0),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            // Status Header
            Card(
              child: Padding(
                padding: const EdgeInsets.symmetric(horizontal: 16.0, vertical: 12.0),
                child: Row(
                  mainAxisAlignment: MainAxisAlignment.spaceBetween,
                  children: [
                    const Text(
                      'SYSTEM STATE',
                      style: TextStyle(fontWeight: FontWeight.bold, letterSpacing: 0.5),
                    ),
                    Row(
                      children: [
                        Container(
                          width: 10,
                          height: 10,
                          decoration: BoxDecoration(
                            shape: BoxShape.circle,
                            color: _getStatusColor(),
                            boxShadow: [
                              BoxShadow(
                                color: _getStatusColor().withValues(alpha: 0.5),
                                blurRadius: 8,
                                spreadRadius: 2,
                              )
                            ],
                          ),
                        ),
                        const SizedBox(width: 8),
                        Text(
                          _callStatus,
                          style: TextStyle(
                            color: _getStatusColor(),
                            fontWeight: FontWeight.bold,
                          ),
                        ),
                      ],
                    ),
                  ],
                ),
              ),
            ),
            const SizedBox(height: 16),

            // Server Config Card
            Card(
              child: Padding(
                padding: const EdgeInsets.all(16.0),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    const Text(
                      'Server Configuration',
                      style: TextStyle(fontSize: 16, fontWeight: FontWeight.bold),
                    ),
                    const SizedBox(height: 12),
                    TextField(
                      controller: _serverUrlController,
                      decoration: const InputDecoration(
                        labelText: 'Secure Tunnel URL (localhost.run)',
                      ),
                      onChanged: (_) => _loadVoices(),
                    ),
                  ],
                ),
              ),
            ),
            const SizedBox(height: 16),

            // Call Setup Card
            Card(
              child: Padding(
                padding: const EdgeInsets.all(16.0),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    const Text(
                      'Call Settings',
                      style: TextStyle(fontSize: 16, fontWeight: FontWeight.bold),
                    ),
                    const SizedBox(height: 12),
                    TextField(
                      controller: _fromNumberController,
                      decoration: const InputDecoration(
                        labelText: 'From Number (Twilio)',
                      ),
                    ),
                    const SizedBox(height: 12),
                    TextField(
                      controller: _toNumberController,
                      decoration: const InputDecoration(
                        labelText: 'To Number (Recipient)',
                        hintText: '+1xxxxxxxxxx',
                      ),
                      keyboardType: TextInputType.phone,
                    ),
                    const SizedBox(height: 12),
                    DropdownButtonFormField<String>(
                      // ignore: deprecated_member_use
                      value: _selectedVoiceId,
                      decoration: const InputDecoration(
                        labelText: 'Target Voice (ElevenLabs)',
                      ),
                      items: _voices.map((voice) {
                        return DropdownMenuItem<String>(
                          value: voice['id'],
                          child: Text('${voice['name']} (${voice['category']})'),
                        );
                      }).toList(),
                      onChanged: (val) {
                        setState(() {
                          _selectedVoiceId = val;
                        });
                      },
                      hint: const Text('Select a voice'),
                    ),
                  ],
                ),
              ),
            ),
            const SizedBox(height: 16),

            // Actions Row
            Row(
              children: [
                Expanded(
                  flex: 2,
                  child: ElevatedButton.icon(
                    onPressed: _callStatus == 'IDLE' || _callStatus == 'ENDED' ? _makeCall : null,
                    icon: const Icon(Icons.phone),
                    label: const Text('Start Call'),
                    style: ElevatedButton.styleFrom(
                      backgroundColor: const Color(0xFF00F2FE),
                      foregroundColor: Colors.black,
                      padding: const EdgeInsets.symmetric(vertical: 14),
                      shape: RoundedRectangleBorder(
                        borderRadius: BorderRadius.circular(8),
                      ),
                    ),
                  ),
                ),
                const SizedBox(width: 8),
                Expanded(
                  child: ElevatedButton.icon(
                    onPressed: _callStatus == 'CONNECTED' || _callStatus == 'CALLING' ? _hangUpCall : null,
                    icon: const Icon(Icons.phone_disabled),
                    label: const Text('Hang Up'),
                    style: ElevatedButton.styleFrom(
                      backgroundColor: const Color(0xFFFF1744),
                      foregroundColor: Colors.white,
                      padding: const EdgeInsets.symmetric(vertical: 14),
                      shape: RoundedRectangleBorder(
                        borderRadius: BorderRadius.circular(8),
                      ),
                    ),
                  ),
                ),
                const SizedBox(width: 8),
                Container(
                  decoration: BoxDecoration(
                    color: _isMuted ? Colors.redAccent.withValues(alpha: 0.2) : Colors.greenAccent.withValues(alpha: 0.1),
                    border: Border.all(
                      color: _isMuted ? Colors.redAccent : Colors.greenAccent,
                      width: 1,
                    ),
                    borderRadius: BorderRadius.circular(8),
                  ),
                  child: IconButton(
                    icon: Icon(
                      _isMuted ? Icons.mic_off : Icons.mic,
                      color: _isMuted ? Colors.redAccent : Colors.greenAccent,
                    ),
                    onPressed: _callStatus == 'CONNECTED' ? _toggleMute : null,
                    tooltip: _isMuted ? 'Unmute Mic' : 'Mute Mic',
                  ),
                ),
              ],
            ),
            const SizedBox(height: 16),

            // Console Logs Card
            Card(
              child: Padding(
                padding: const EdgeInsets.all(16.0),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    Row(
                      mainAxisAlignment: MainAxisAlignment.spaceBetween,
                      children: [
                        const Text(
                          'Terminal Log',
                          style: TextStyle(fontSize: 16, fontWeight: FontWeight.bold),
                        ),
                        TextButton(
                          onPressed: () {
                            setState(() {
                              _logs.clear();
                              _log('Logs cleared.');
                            });
                          },
                          child: const Text('Clear'),
                        ),
                      ],
                    ),
                    const SizedBox(height: 8),
                    Container(
                      height: 150,
                      decoration: BoxDecoration(
                        color: Colors.black.withValues(alpha: 0.9),
                        borderRadius: BorderRadius.circular(8),
                        border: Border.all(color: const Color(0xFF38446B).withValues(alpha: 0.4)),
                      ),
                      child: ListView.builder(
                        padding: const EdgeInsets.all(8.0),
                        itemCount: _logs.length,
                        itemBuilder: (context, index) {
                          return Padding(
                            padding: const EdgeInsets.only(bottom: 4.0),
                            child: Text(
                              _logs[index],
                              style: const TextStyle(
                                fontFamily: 'monospace',
                                fontSize: 11,
                                color: Color(0xFFA4B3CC),
                              ),
                            ),
                          );
                        },
                      ),
                    ),
                  ],
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}
