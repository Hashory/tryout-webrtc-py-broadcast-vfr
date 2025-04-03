import argparse
import asyncio
import fractions
import json
import logging
import os
import ssl
import time
import uuid

import cv2  # OpenCV for generating dummy frames
import numpy as np
from aiohttp import web
from aiortc import MediaStreamTrack, RTCPeerConnection, RTCSessionDescription
from aiortc.contrib.media import MediaRelay

# Logger configuration
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Root directory setting
ROOT = os.path.dirname(__file__)

# Set to hold connected peer connections and data channels
pcs = set()
# Media relay (used to distribute the same track to multiple clients)
relay = MediaRelay()


class DynamicFrameVideoStreamTrack(MediaStreamTrack):
    """
    Custom video track that generates and sends frames in response to signals from DataChannel.
    """

    kind = "video"

    def __init__(self):
        super().__init__()
        self._queue = asyncio.Queue(
            maxsize=1
        )  # Queue to hold frames (only the latest 1 frame)
        self._last_frame_time = 0
        self._frame_count = 0
        logger.info("DynamicFrameVideoStreamTrack initialized")

    async def request_frame(self):
        """
        Requests the generation of a new frame and its addition to the queue.
        """
        now = time.time()
        # Generate a simple frame (here, draw timestamp and frame number)
        img = np.zeros((480, 640, 3), dtype=np.uint8)
        text = f"Frame: {self._frame_count} Time: {now:.2f}"
        cv2.putText(
            img, text, (50, 240), cv2.FONT_HERSHEY_SIMPLEX, 1, (255, 255, 255), 2
        )
        frame = cv2.cvtColor(
            img, cv2.COLOR_BGR2GRAY
        )  # aiortc usually expects a specific format

        # Convert to aiortc.VideoFrame (simplified here)
        # In a real application, proper format and timestamp settings are required
        from av import VideoFrame

        pts = int(now * 1000)  # Presentation timestamp (milliseconds)
        video_frame = VideoFrame.from_ndarray(frame, format="gray")  # Use gray format
        video_frame.pts = pts
        video_frame.time_base = fractions.Fraction(1, 1000)  # Millisecond time base

        logger.info(f"Generated frame {self._frame_count} at {now:.2f}")
        self._frame_count += 1

        # Discard the oldest frame if the queue is full
        if self._queue.full():
            await self._queue.get()
        await self._queue.put(video_frame)

    async def recv(self):
        """
        Called by aiortc, returns the next frame to send.
        Waits if there are no frames in the queue.
        """
        # logger.info("recv() called, waiting for frame...")
        frame = await self._queue.get()
        logger.info(f"Sending frame {frame.pts}")
        return frame


# Global video track instance
# (using relay is common when sharing with multiple clients,
#  but here, each client has its own track for simplicity)
# video_track = DynamicFrameVideoStreamTrack()


async def index(request):
    """
    Handler to provide the client's HTML page.
    """
    content = open(os.path.join(ROOT, "client.html"), "r", encoding="utf-8").read()
    return web.Response(content_type="text/html", text=content)


async def javascript(request):
    """
    Handler to provide the client's JavaScript file.
    """
    content = open(os.path.join(ROOT, "client.js"), "r", encoding="utf-8").read()
    return web.Response(content_type="application/javascript", text=content)


async def offer(request):
    """
    Handler to receive SDP offers from the client and return an answer.
    """
    params = await request.json()
    offer = RTCSessionDescription(sdp=params["sdp"], type=params["type"])

    pc = RTCPeerConnection()
    pc_id = f"PeerConnection({uuid.uuid4()})"
    pcs.add(pc)

    # Create a new video track for the new client
    video_track = DynamicFrameVideoStreamTrack()

    def log_info(msg, *args):
        logger.info(pc_id + " " + msg, *args)

    log_info("Created for %s", request.remote)

    @pc.on("datachannel")
    def on_datachannel(channel):
        log_info(f"Data channel '{channel.label}' created")

        @channel.on("message")
        async def on_message(message):
            log_info(f"Message from data channel '{channel.label}': {message}")
            if message == "send_frame":
                log_info("Frame request received via DataChannel")
                # Request frame transmission to the corresponding video track
                await video_track.request_frame()
            elif message.startswith("ping"):
                # Simple echo confirmation
                channel.send("pong" + message[4:])

    @pc.on("connectionstatechange")
    async def on_connectionstatechange():
        log_info(f"Connection state is {pc.connectionState}")
        if pc.connectionState == "failed" or pc.connectionState == "closed":
            await pc.close()
            pcs.discard(pc)
            log_info("Connection closed")

    @pc.on("track")
    def on_track(track):
        log_info(f"Track {track.kind} received")

        # Normally, the server does not receive tracks, but it can be used for echo tests, etc.
        @track.on("ended")
        async def on_ended():
            log_info(f"Track {track.kind} ended")

    # Add video track
    pc.addTrack(video_track)

    # Set the offer and create an answer
    await pc.setRemoteDescription(offer)
    answer = await pc.createAnswer()
    await pc.setLocalDescription(answer)

    log_info("Returning SDP answer")
    return web.Response(
        content_type="application/json",
        text=json.dumps(
            {"sdp": pc.localDescription.sdp, "type": pc.localDescription.type}
        ),
    )


async def on_shutdown(app):
    """
    Close peer connections when the server shuts down.
    """
    # Close all peer connections
    coros = [pc.close() for pc in pcs]
    await asyncio.gather(*coros)
    pcs.clear()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="WebRTC variable frame rate server")
    parser.add_argument("--cert-file", help="SSL certificate file (for HTTPS)")
    parser.add_argument("--key-file", help="SSL key file (for HTTPS)")
    parser.add_argument(
        "--host", default="0.0.0.0", help="Host for HTTP server (default: 0.0.0.0)"
    )
    parser.add_argument(
        "--port", type=int, default=8080, help="Port for HTTP server (default: 8080)"
    )
    args = parser.parse_args()

    if args.cert_file and args.key_file:
        ssl_context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        ssl_context.load_cert_chain(args.cert_file, args.key_file)
    else:
        ssl_context = None
        logger.warning(
            "Running without HTTPS. WebRTC might not work in some browsers without HTTPS."
        )

    app = web.Application()
    app.on_shutdown.append(on_shutdown)
    app.router.add_get("/", index)
    app.router.add_get("/client.js", javascript)
    app.router.add_post("/offer", offer)

    web.run_app(app, host=args.host, port=args.port, ssl_context=ssl_context)
