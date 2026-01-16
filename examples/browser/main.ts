import { RTCFetcher, RTCFetcherError } from '@yuphon/rtcfetcher';

// DOM Elements
const connectBtn = document.getElementById('connectBtn') as HTMLButtonElement;
const sendReqBtn = document.getElementById('sendReqBtn') as HTMLButtonElement;
const sendStreamBtn = document.getElementById('sendStreamBtn') as HTMLButtonElement;
const sendLargeBtn = document.getElementById('sendLargeBtn') as HTMLButtonElement;
const sendMtuStreamBtn = document.getElementById('sendMtuStreamBtn') as HTMLButtonElement;
const log1 = document.getElementById('log1') as HTMLDivElement;
const log2 = document.getElementById('log2') as HTMLDivElement;

function log(peer: 1 | 2, msg: string, data?: any) {
    const div = document.createElement('div');
    const time = new Date().toLocaleTimeString();
    div.textContent = `[${time}] ${msg} ${data ? JSON.stringify(data) : ''}`;
    if (peer === 1) {
        log1.appendChild(div);
        log1.scrollTop = log1.scrollHeight;
    } else {
        log2.appendChild(div);
        log2.scrollTop = log2.scrollHeight;
    }
    console.log(`[Peer${peer}]`, msg, data || '');
}

// Peer setup
const pc1 = new RTCPeerConnection();
const pc2 = new RTCPeerConnection();

// ICE Handling
pc1.onicecandidate = e => {
    if (e.candidate) {
        log(1, 'ICE Candidate generated');
        pc2.addIceCandidate(e.candidate).catch(e => log(1, 'AddICE Error', e));
    }
};
pc2.onicecandidate = e => {
    if (e.candidate) {
        log(2, 'ICE Candidate generated');
        pc1.addIceCandidate(e.candidate).catch(e => log(2, 'AddICE Error', e));
    }
};

// State logging
pc1.onconnectionstatechange = () => log(1, `Connection State: ${pc1.connectionState}`);
pc2.onconnectionstatechange = () => log(2, `Connection State: ${pc2.connectionState}`);

// 2. Setup RTCFetcher
const fetcher1 = new RTCFetcher(pc1, {
    prefetchPoolSize: 0 // Disable pool to force 1-RTT negotiation for every request
});
const fetcher2 = new RTCFetcher(pc2, {
    prefetchPoolSize: 0 // Disable pool to force 1-RTT negotiation for every request
});

// Helper to read and log stream
async function readAndLogStream(peer: 1 | 2, name: string, stream: ReadableStream, isBinary = false) {
    const reader = stream.getReader();
    log(peer, `Start reading stream: ${name}`);
    let total = 0;
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) {
                log(peer, `Stream ${name} finished. Total bytes: ${total}`);
                break;
            }
            total += value.byteLength;
            if (isBinary) {
                log(peer, `[${name}] Received chunk: ${value.byteLength} bytes. (Total: ${total})`);
            } else {
                const text = new TextDecoder().decode(value);
                log(peer, `[${name}] Received: ${text}`);
            }
        }
    } catch (e) {
        log(peer, `Stream ${name} error`, e);
    }
}

// Setup Receiver (Peer 2)
function setupReceiver() {
    const reader = fetcher2.incomingRequests.getReader();
    log(2, 'Waiting for requests...');

    (async () => {
        try {
            while (true) {
                const { done, value: req } = await reader.read();
                if (done) break;

                log(2, `Received Request: ${req.label}`);
                log(1, `[Remote] Peer 2 confirmed receipt of request: ${req.label}`);

                // Open request to get body
                const { req: requestData, res } = await req.open();
                // log(2, 'Request Body:', requestData.body);

                // Consume streams if present
                const body = requestData.body;
                if (body && typeof body === 'object') {
                    if (body.myStream instanceof ReadableStream) {
                        readAndLogStream(2, 'myStream', body.myStream);
                    }
                    if (body.myStream2 instanceof ReadableStream) {
                        readAndLogStream(2, 'myStream2', body.myStream2);
                    }
                    if (body.data instanceof ReadableStream) {
                        log(2, 'Received "data" as ReadableStream (Auto-streamed)!');
                        readAndLogStream(2, 'data-stream', body.data, true);
                    } else if (body.data) {
                        log(2, `Received "data" as normal object. Size: ${body.data.byteLength || body.data.length}`);
                    }
                }

                // Simulate processing delay
                await new Promise(r => setTimeout(r, 500));

                // Send response (Without echoing streams, as they are being consumed)
                const responseData = {
                    msg: "Streams received and being processed",
                    timestamp: Date.now(),
                    receiver: 'Peer2'
                };
                log(2, 'Sending Response', responseData);
                res.send(responseData);
            }
        } catch (e) {
            log(2, 'Error in receiver loop', e);
        }
    })();
}
setupReceiver();

// Connect Peers
connectBtn.addEventListener('click', async () => {
    try {
        log(1, 'Connecting...');
        const offer = await pc1.createOffer();
        await pc1.setLocalDescription(offer);
        await pc2.setRemoteDescription(offer);

        const answer = await pc2.createAnswer();
        await pc2.setLocalDescription(answer);
        await pc1.setRemoteDescription(answer);

        // Wait for fetcher ready?
        await fetcher1.opened;
        log(1, 'RTCFetcher Opened');

        connectBtn.disabled = true;
        sendReqBtn.disabled = false;
        sendStreamBtn.disabled = false;
        sendLargeBtn.disabled = false;
        sendMtuStreamBtn.disabled = false;
    } catch (e) {
        log(1, 'Connection failed', e);
    }
});

// Send Request
sendReqBtn.addEventListener('click', async () => {
    try {
        const payload = { msg: 'Hello from Peer1', rand: Math.random() };
        log(1, 'Sending Request (echo)', payload);

        const response = await fetcher1.fetch('echo', payload);
        log(1, 'Got Response Object');

        const json = await response.json();
        log(1, 'Parsed Response JSON:', json);
    } catch (e) {
        log(1, 'Fetch Error', e);
        if (e instanceof RTCFetcherError) {
            log(1, `Error Code: ${e.code}`);
        }
    }
});

// Send Stream Request
sendStreamBtn.addEventListener('click', async () => {
    try {
        log(1, 'Creating 2 Streams...');

        const stream1 = new ReadableStream({
            start(controller) {
                let i = 0;
                const interval = setInterval(() => {
                    if (i >= 5) {
                        clearInterval(interval);
                        controller.close();
                        return;
                    }
                    const chunk = `S1-Chunk-${i++}`;
                    controller.enqueue(new TextEncoder().encode(chunk));
                }, 200);
            }
        });

        const stream2 = new ReadableStream({
            start(controller) {
                let i = 0;
                const interval = setInterval(() => {
                    if (i >= 5) {
                        clearInterval(interval);
                        controller.close();
                        return;
                    }
                    const chunk = `S2-Chunk-${i++}`;
                    controller.enqueue(new TextEncoder().encode(chunk));
                }, 300); // Different timing
            }
        });

        log(1, 'Sending Request with 2 Streams');
        // We send 2 distinct streams
        const response = await fetcher1.fetch('stream-echo', { myStream: stream1, myStream2: stream2 });
        const json = await response.json();
        log(1, 'Response:', json);

    } catch (e) {
        log(1, 'Stream Fetch Error', e);
    }
});

// Send Large Data (Auto-Stream Test)
sendLargeBtn.addEventListener('click', async () => {
    try {
        const size = 20 * 1024; // 20KB (> 16KB Threshold)
        log(1, `Sending Large Data (${size} bytes) - Should be auto-streamed...`);
        const payload = new Uint8Array(size);
        // Fill with recognizable pattern
        for (let i = 0; i < size; i++) payload[i] = i % 255;

        const start = Date.now();
        // The receiver should receive this as a ReadableStream if logic works
        const response = await fetcher1.fetch('large-data', { data: payload });
        const json = await response.json();
        const duration = Date.now() - start;

        log(1, `Large Data Fetch Complete in ${duration}ms`, json);
    } catch (e) {
        log(1, 'Large Data Error', e);
    }
});

// Send Stream with Large Chunks (MTU Test)
sendMtuStreamBtn.addEventListener('click', async () => {
    try {
        log(1, 'Starting MTU Stream Test (Sending 32KB chunks)...');
        const chunkSize = 32 * 1024; // 32KB (Larger than 16KB MTU)
        const totalChunks = 5;

        const stream = new ReadableStream({
            start(controller) {
                let i = 0;
                const pushChunk = () => {
                    if (i >= totalChunks) {
                        controller.close();
                        return;
                    }
                    const chunk = new Uint8Array(chunkSize);
                    // Fill with recognizable pattern
                    chunk.fill(i + 1);
                    controller.enqueue(chunk);
                    i++;
                    log(1, `Enqueued chunk ${i}/${totalChunks} (${chunkSize} bytes)`);

                    setTimeout(pushChunk, 100);
                };
                pushChunk();
            }
        });

        const start = Date.now();
        const response = await fetcher1.fetch('mtu-stream', { myStream: stream });
        const json = await response.json();
        const duration = Date.now() - start;

        log(1, `MTU Stream Test Complete in ${duration}ms`, json);
    } catch (e) {
        log(1, 'MTU Stream Test Error', e);
    }
});
