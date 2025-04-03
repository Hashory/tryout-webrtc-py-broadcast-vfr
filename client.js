'use strict';

// Global variables
let pc = null; // RTCPeerConnection
let dc = null; // RTCDataChannel
let dcInterval = null; // Interval for DataChannel ping

const startButton = document.getElementById('start');
const requestFrameButton = document.getElementById('request-frame');
const stopButton = document.getElementById('stop');
const videoElement = document.getElementById('video');
const logElement = document.getElementById('logs');

// --- Logging ---
function log(message) {
    console.log(message);
    const now = new Date();
    const timeString = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', fractionalSecondDigits: 3 });
    logElement.textContent += `[${timeString}] ${message}\n`;
    logElement.scrollTop = logElement.scrollHeight; // Auto-scroll
}

// --- WebRTC Negotiation ---
function negotiate() {
    log('Starting negotiation...');
    return pc.createOffer().then((offer) => {
        log('Offer creation successful');
        return pc.setLocalDescription(offer);
    }).then(() => {
        log('Local Description setting successful');
        // Wait for ICE gathering to complete
        return new Promise((resolve) => {
            if (pc.iceGatheringState === 'complete') {
                resolve();
            } else {
                function checkState() {
                    if (pc.iceGatheringState === 'complete') {
                        pc.removeEventListener('icegatheringstatechange', checkState);
                        resolve();
                    }
                }
                pc.addEventListener('icegatheringstatechange', checkState);
            }
        });
    }).then(() => {
        log('ICE gathering complete, sending Offer to server');
        const offer = pc.localDescription;
        return fetch('/offer', {
            body: JSON.stringify({
                sdp: offer.sdp,
                type: offer.type,
            }),
            headers: {
                'Content-Type': 'application/json'
            },
            method: 'POST'
        });
    }).then((response) => {
        log('Received Answer from server');
        return response.json();
    }).then((answer) => {
        log('Answer setting started');
        return pc.setRemoteDescription(answer);
    }).then(() => {
        log('Remote Description setting successful, establishing connection');
    }).catch((e) => {
        log(`Negotiation failed: ${e}`);
        alert(`Negotiation failed: ${e}`);
        stop(); // Stop on error
    });
}

// --- Start Connection ---
function start() {
    log('Start connection button clicked');
    startButton.disabled = true;
    stopButton.disabled = false;

    // RTCPeerConnection configuration
    const config = {
        // Specify STUN/TURN servers if necessary
        // iceServers: [{urls: 'stun:stun.l.google.com:19302'}]
    };

    pc = new RTCPeerConnection(config);

    // Add "video" transceiver with "recvonly" direction
    pc.addTransceiver('video', { direction: 'recvonly' });

    // Monitor connection state changes
    pc.addEventListener('connectionstatechange', () => {
        log(`Connection state changed: ${pc.connectionState}`);
        if (pc.connectionState === 'connected') {
            log('Connection successful!');
            requestFrameButton.disabled = false; // Enable frame request button after connection
        } else if (pc.connectionState === 'failed' || pc.connectionState === 'closed' || pc.connectionState === 'disconnected') {
            log('Connection has been disconnected.');
            stop(); // Reset state
        }
    });

    // Handle receiving remote track (video)
    pc.addEventListener('track', (evt) => {
        log(`Remote track received: ${evt.track.kind}`);
        if (evt.track.kind === 'video') {
            log('Adding video track to <video> element');
            videoElement.srcObject = evt.streams[0];
        }
    });

    // Create DataChannel (created from client instead of waiting for server)
    // Create DataChannel with label 'chat'
    dc = pc.createDataChannel('chat', { negotiated: false }); // negotiated: false for auto-negotiation
    log(`DataChannel '${dc.label}' creation attempt`);

    dc.onopen = () => {
        log(`DataChannel '${dc.label}' open`);
        // Send ping periodically to check connection when DataChannel is open (optional)
        dcInterval = setInterval(() => {
            try {
                const message = 'ping ' + Date.now();
                // log(`Sending ping: ${message}`); // Comment out if logs are too verbose
                dc.send(message);
            } catch (e) {
                log(`Ping send error: ${e}`);
                // Stop interval if error occurs
                if (dcInterval) {
                    clearInterval(dcInterval);
                    dcInterval = null;
                }
            }
        }, 5000); // Every 5 seconds
    };

    dc.onclose = () => {
        log(`DataChannel '${dc.label}' closed`);
        if (dcInterval) {
            clearInterval(dcInterval);
            dcInterval = null;
        }
        // Disable frame request button when DataChannel is closed
        requestFrameButton.disabled = true;
    };

    dc.onerror = (error) => {
        log(`DataChannel '${dc.label}' error: ${error}`);
    };

    dc.onmessage = (evt) => {
        // log(`Message from DataChannel '${dc.label}': ${evt.data}`);
        if (evt.data.substring(0, 4) === 'pong') {
            const roundtrip = Date.now() - parseInt(evt.data.substring(5), 10);
            // log(`Received pong, RTT: ${roundtrip} ms`); // Comment out if logs are too verbose
        } else {
            log(`Message from DataChannel '${dc.label}': ${evt.data}`);
        }
    };

    // Start negotiation
    negotiate();
}

// --- Request Frame ---
function requestFrame() {
    if (dc && dc.readyState === 'open') {
        log("Sending frame request via DataChannel: 'send_frame'");
        dc.send('send_frame');
    } else {
        log('Frame request failed: DataChannel is not open');
        alert('DataChannel is not open. Please check the connection.');
    }
}

// --- Stop Connection ---
function stop() {
    log('Stop connection button clicked / Starting stop process');
    startButton.disabled = false;
    stopButton.disabled = true;
    requestFrameButton.disabled = true;

    // Clear DataChannel ping interval
    if (dcInterval) {
        clearInterval(dcInterval);
        dcInterval = null;
        log('DataChannel ping interval stopped');
    }

    // Close DataChannel
    if (dc) {
        log('Closing DataChannel');
        dc.close();
        dc = null;
    }

    // Close PeerConnection
    if (pc) {
        log('Closing PeerConnection');
        // It's safer to remove event listeners
        pc.ontrack = null;
        pc.onicegatheringstatechange = null;
        pc.onconnectionstatechange = null;

        // Close after a short delay (avoid signaling errors)
        setTimeout(() => {
            if (pc) { // Close only if it still exists
               pc.close();
               pc = null;
               log('PeerConnection close complete');
            }
        }, 500);
    }

    // Reset video element
    videoElement.srcObject = null;
    log('Video element reset');

    // Clear logs (optional)
    // logElement.textContent = '';

    log('Stop process complete');
}

// Initial state setting
stopButton.disabled = true;
requestFrameButton.disabled = true;
