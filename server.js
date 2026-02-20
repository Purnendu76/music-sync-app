const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const SpotifyWebApi = require('spotify-web-api-node');
const { fork } = require('child_process');
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "*", // allow all origins for now
    methods: ["GET", "POST"]
  }
});

app.use(cors());

// --- SPOTIFY AUTH CONFIG ---
// You will need to set these environment variables or hardcode them (not recommended for production)
const CLIENT_ID = process.env.SPOTIFY_CLIENT_ID || 'f6d8bdb30b4240169dbbe4e7e83bba5a';
const CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET || 'ea179b38c9674a1ba5b7956fc103ed17';
const REDIRECT_URI = process.env.SPOTIFY_REDIRECT_URI || 'http://localhost:8888/callback';

const spotifyApi = new SpotifyWebApi({
  clientId: CLIENT_ID,
  clientSecret: CLIENT_SECRET,
  redirectUri: REDIRECT_URI
});

console.log(`[DEBUG] Using Client ID: ${CLIENT_ID}`);
console.log(`[DEBUG] Using Redirect URI: ${REDIRECT_URI}`);

// --- REST API ROUTES ---

// 1. Login Route: Redirects user to Spotify Auth Page
app.get('/login', (req, res) => {
  const scopes = [
    'user-read-playback-state',
    'user-modify-playback-state',
    'user-read-currently-playing'
  ];
  const authorizeURL = spotifyApi.createAuthorizeURL(scopes);
  res.redirect(authorizeURL);
});

// 2. Callback Route: Handles the code from Spotify and gets tokens
app.get('/callback', async (req, res) => {
  const error = req.query.error;
  const code = req.query.code;
  const state = req.query.state;

  if (error) {
    console.error('Callback Error:', error);
    res.send(`Callback Error: ${error}`);
    return;
  }

  try {
    const data = await spotifyApi.authorizationCodeGrant(code);
    const accessToken = data.body['access_token'];
    const refreshToken = data.body['refresh_token'];
    const expiresIn = data.body['expires_in'];

    // For simplicity, we just display these to the user so they can copy them to the client
    // In a production app, you'd save this to a database session or send it to the client app via deep link
    res.send(`
      <h1>Login Successful!</h1>
      <p>Please copy these credentials into your <code>credentials.json</code> file or client script configuration.</p>
      <p><strong>Access Token:</strong> <br> <textarea rows="4" cols="100">${accessToken}</textarea></p>
      <p><strong>Refresh Token:</strong> <br> <textarea rows="2" cols="100">${refreshToken}</textarea></p>
      <p>Expires in: ${expiresIn} seconds</p>
    `);

    // Optionally set them on the server instance (not really needed for this "bridge" server but good for debugging)
    spotifyApi.setAccessToken(accessToken);
    spotifyApi.setRefreshToken(refreshToken);

  } catch (error) {
    console.error('Error getting Tokens:', error);
    res.send(`Error getting Tokens: ${error}`);
  }
});

// --- SOCKET.IO ---

io.on('connection', (socket) => {
  console.log('New client connected:', socket.id);

  socket.on('join-room', (roomId) => {
    socket.join(roomId);
    console.log(`Socket ${socket.id} joined room ${roomId}`);
  });

  // When the 'Leader' sends a sync event
  socket.on('send-sync', (data) => {
    // Broadcast to everyone else in the room (client.js logic handles playing the URI)
    console.log(`Syncing room ${data.roomId} to ${data.uri} @ ${data.position}ms`);
    socket.to(data.roomId).emit('receive-sync', data);
  });

  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
  });
});

// Start the server
const PORT = process.env.PORT || 8888;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Server is live on port ${PORT}`);

  // Start client.js automatically after a short delay to ensure the server is ready
  setTimeout(() => {
    console.log('[DEBUG] Starting client.js...');
    fork('./client.js');
  }, 1000);
});