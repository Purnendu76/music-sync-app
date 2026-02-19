const io = require('socket.io-client');
const SpotifyWebApi = require('spotify-web-api-node');
const fs = require('fs');

// --- CONFIGURATION ---
// 1. Enter your server URL (use ngrok for remote connections)
const SERVER_URL = 'http://localhost:8888'; // updated after ngrok

// 2. Load credentials from file
let credentials = {};
try {
    credentials = JSON.parse(fs.readFileSync('credentials.json', 'utf8'));
} catch (err) {
    console.error("Error reading credentials.json. make sure to create it and populate it with your tokens.");
    process.exit(1);
}

// 3. Initialize Socket.io and Spotify Client
const socket = io(SERVER_URL);
const spotifyApi = new SpotifyWebApi({
    clientId: credentials.clientId,
    clientSecret: credentials.clientSecret,
    redirectUri: 'http://localhost:3000/callback',
    refreshToken: credentials.refreshToken,
    accessToken: credentials.accessToken
});

// --- HELPER FUNCTIONS ---

// Function to refresh the access token
async function refreshAccessToken() {
    try {
        const data = await spotifyApi.refreshAccessToken();
        const accessToken = data.body['access_token'];

        // Save the new access token
        spotifyApi.setAccessToken(accessToken);
        credentials.accessToken = accessToken;
        fs.writeFileSync('credentials.json', JSON.stringify(credentials, null, 2));

        console.log('The access token has been refreshed!');
    } catch (err) {
        console.log('Could not refresh access token', err);
    }
}

// Check if we need to refresh token immediately or set an interval
// Spotify tokens last 1 hour. We can refresh every 50 minutes.
setInterval(refreshAccessToken, 50 * 60 * 1000);

// Initial Refresh to make sure we're good to go on start
refreshAccessToken();

// --- SYNC LOGIC ---

// Defines if this client is the LEADER (sends commands) or FOLLOWER (receives commands)
const MODE = process.argv[2] || 'follower'; // default to follower
const ROOM_ID = 'my-super-secret-room';

console.log(`Starting in ${MODE} mode... joining room ${ROOM_ID}`);

socket.on('connect', () => {
    console.log('Connected to server');
    socket.emit('join-room', ROOM_ID);
});

if (MODE === 'leader') {
    // LEADER LOGIC: 
    // Poll Spotify for playback state changes and emit to server
    // (In a real app, you might use webhooks or user interaction events, but polling is easiest for scripts)

    let lastUri = '';
    let lastIsPlaying = false;

    setInterval(async () => {
        try {
            const data = await spotifyApi.getMyCurrentPlaybackState();

            if (data.body && data.body.item) {
                const currentUri = data.body.item.uri; // e.g., spotify:track:12345
                const isPlaying = data.body.is_playing;
                const progressMs = data.body.progress_ms;

                // If track changed or playback state changed (play/pause)
                // We broadcast a sync event
                if (currentUri !== lastUri || isPlaying !== lastIsPlaying) {
                    console.log(`Leader State Change: ${currentUri} isPlaying: ${isPlaying}`);

                    socket.emit('send-sync', {
                        roomId: ROOM_ID,
                        uri: currentUri,
                        isPlaying: isPlaying,
                        position: progressMs,
                        timestamp: Date.now()
                    });

                    lastUri = currentUri;
                    lastIsPlaying = isPlaying;
                }
            }
        } catch (err) {
            console.error("Leader Error:", err.statusCode);
            // If 401, token might be expired, but interval handles refresh
        }
    }, 5000); // Check every 5 seconds

} else {
    // FOLLOWER LOGIC:
    // Listen for sync events and apply them

    socket.on('receive-sync', async (data) => {
        console.log('Received Sync:', data);

        try {
            const { uri, isPlaying, position, timestamp } = data;

            // Calculate network delay
            const now = Date.now();
            const delay = now - timestamp;
            const adjustedPosition = position + delay; // where we should be now

            // 1. Check if we need to change track
            const currentPlayback = await spotifyApi.getMyCurrentPlaybackState();

            if (!currentPlayback.body || !currentPlayback.body.item || currentPlayback.body.item.uri !== uri) {
                console.log(`Follower: Changing track to ${uri}`);
                await spotifyApi.play({ uris: [uri], position_ms: adjustedPosition });
            } else {
                // Track is same, check if we need to seek or play/pause
                const currentPosition = currentPlayback.body.progress_ms;

                // Only seek if we are off by more than 2 seconds
                if (Math.abs(currentPosition - adjustedPosition) > 2000) {
                    console.log(`Follower: Seeking to ${adjustedPosition}`);
                    await spotifyApi.seek(adjustedPosition);
                }

                if (isPlaying && !currentPlayback.body.is_playing) {
                    console.log('Follower: Resuming playback');
                    await spotifyApi.play();
                } else if (!isPlaying && currentPlayback.body.is_playing) {
                    console.log('Follower: Pausing playback');
                    await spotifyApi.pause();
                }
            }
        } catch (err) {
            console.error("Follower Error:", err.message);
        }
    });
}
