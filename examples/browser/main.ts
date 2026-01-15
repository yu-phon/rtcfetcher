import { RTCFetcher, RTCFetcherError } from '@yuphon/rtcfetcher';

// DOM Elements
const connectBtn = document.getElementById('connectBtn') as HTMLButtonElement;
const sendReqBtn = document.getElementById('sendReqBtn') as HTMLButtonElement;
const sendStreamBtn = document.getElementById('sendStreamBtn') as HTMLButtonElement;
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

// RTCFetcher init
const fetcher1 = new RTCFetcher(pc1);
const fetcher2 = new RTCFetcher(pc2);

// Setup Receiver (Peer 2)
function setupReceiver() {
    const reader = fetcher2.incomingRequests.getReader();
    log(2, 'Waiting for requests...');

    (async () => {
        try {
            while (true) {
                const { done, value: req } = await reader.read();
                if (done) break;

                log(2, `Received Request: ${req.endpoint}`);
                log(1, `[Remote] Peer 2 confirmed receipt of request: ${req.endpoint}`);

                // Open request to get body
                const { req: requestData, res } = await req.open();
                log(2, 'Request Body:', requestData.body);

                // Simulate processing delay
                await new Promise(r => setTimeout(r, 500));

                // Send response
                const responseData = {
                    echo: requestData.body,
                    timestamp: Date.now(),
                    receiver: 'Peer2'
                };
                log(2, 'Sending Response', responseData);
                res.send(responseData);
                // res.close(); // Optional, depending on if we want to stream more
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
        const stream = new ReadableStream({
            start(controller) {
                let i = 0;
                const interval = setInterval(() => {
                    if (i >= 5) {
                        clearInterval(interval);
                        controller.close();
                        return;
                    }
                    const chunk = `Chunk ${i++} `;
                    controller.enqueue(new TextEncoder().encode(chunk));
                }, 200);
            }
        });

        // We can send stream as part of body!
        // Supported by new codec.
        log(1, 'Sending Stream Request');
        const response = await fetcher1.fetch('stream-echo', { myStream: stream });
        const json = await response.json();
        log(1, 'Response:', json);

        // Receiver should encounter StreamRef. 
        // Our receiver logic just echoes it back.
        // If receiver sends back the StreamRef, we get a ReadableStream back!
        // Let's see how `json` looks.
    } catch (e) {
        log(1, 'Stream Fetch Error', e);
    }
});
