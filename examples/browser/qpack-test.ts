
import { RTCFetcher } from '@yuphon/rtcfetcher';

// UI Refs
const connectBtn = document.getElementById('connectBtn') as HTMLButtonElement;
const sendFlatBtn = document.getElementById('sendFlatBtn') as HTMLButtonElement;
const sendDeepBtn = document.getElementById('sendDeepBtn') as HTMLButtonElement;
const sendArrayBtn = document.getElementById('sendArrayBtn') as HTMLButtonElement;
const sendMixedBtn = document.getElementById('sendMixedBtn') as HTMLButtonElement;
const sendRepeatedBtn = document.getElementById('sendRepeatedBtn') as HTMLButtonElement;

const log1 = document.getElementById('log1') as HTMLDivElement;
const log2 = document.getElementById('log2') as HTMLDivElement;

function log(peer: 1 | 2, msg: string, data?: any) {
    const div = document.createElement('div');
    const time = new Date().toLocaleTimeString();
    let content = `[${time}] ${msg}`;
    if (data !== undefined) {
        content += '\n' + JSON.stringify(data, null, 2);
    }
    div.innerText = content;
    if (peer === 1) {
        log1.appendChild(div);
        log1.scrollTop = log1.scrollHeight;
    } else {
        log2.appendChild(div);
        log2.scrollTop = log2.scrollHeight;
    }
}

// WebRTC Setup
const pc1 = new RTCPeerConnection();
const pc2 = new RTCPeerConnection();

pc1.onicecandidate = e => e.candidate && pc2.addIceCandidate(e.candidate);
pc2.onicecandidate = e => e.candidate && pc1.addIceCandidate(e.candidate);

const fetcher1 = new RTCFetcher(pc1);
const fetcher2 = new RTCFetcher(pc2);

// Connection Logic
connectBtn.addEventListener('click', async () => {
    log(1, 'Establishing connection...');
    const offer = await pc1.createOffer();
    await pc1.setLocalDescription(offer);
    await pc2.setRemoteDescription(offer);
    const answer = await pc2.createAnswer();
    await pc2.setLocalDescription(answer);
    await pc1.setRemoteDescription(answer);

    await fetcher1.opened;
    log(1, 'RTCFetcher Connected!');

    connectBtn.disabled = true;
    sendFlatBtn.disabled = false;
    sendDeepBtn.disabled = false;
    sendArrayBtn.disabled = false;
    sendMixedBtn.disabled = false;
    sendRepeatedBtn.disabled = false;
});

// Receiver Logic
(async () => {
    log(2, "Receiver Loop Started. Waiting for requests...");
    const reader = fetcher2.incomingRequests.getReader();
    while (true) {
        log(2, "Waiting for reader.read()...");
        const { done, value: req } = await reader.read();
        if (done) {
            log(2, "Receiver Loop Ended (Done).");
            break;
        }

        log(2, `Dequeued Request object. Label: ${req.label}. Opening...`);
        try {
            const { req: requestData, res } = await req.open();
            log(2, `OPENED! Body: ${JSON.stringify(requestData.body)}`);

            // Simple echo response with metadata to test response encoding too
            res.send({
                echo: true,
                receivedTimestamp: Date.now(),
                originalBody: requestData.body
            });
            log(2, "Response Sent.");
        } catch (e) {
            log(2, `Error handling request [${req.label}]: ${e}`);
            console.error(e);
        }
    }
})();

// Helper to update stats after request
function trackRequestStats(data: any, res: any) {
    log(1, "[StatsDebug] trackRequestStats called");
    try {
        const raw = JSON.stringify(data).length; // Approx
        // @ts-ignore
        const stats = res.qpackStats;
        log(1, `[StatsDebug] res.qpackStats: ${JSON.stringify(stats)}`);

        const enc = stats?.requestEncodedSize || 0;
        log(1, `[StatsDebug] Raw: ${raw}, Enc: ${enc}`);

        updateStatsUI(raw, enc);
        updateDynamicTableViz();
    } catch (e) {
        log(1, `[StatsDebug] Error: ${e}`);
        console.error("[StatsDebug] Error in trackRequestStats:", e);
    }
}

// Tests
sendFlatBtn.addEventListener('click', async () => {
    log(1, '--- Sending Flat Object ---');
    const data = { name: "Alice", age: 30, city: "Wonderland", active: true };
    const res = await fetcher1.fetch('qpack-flat', data);
    const json = await res.json();
    log(1, 'Response:', json);
    trackRequestStats(data, res);
});

sendDeepBtn.addEventListener('click', async () => {
    log(1, '--- Sending Deep Object ---');
    const data = {
        config: {
            server: { host: "localhost", port: 8080 },
            flags: { verbose: true, debug: false }
        },
        users: {
            admin: { name: "Root" },
            guest: { name: "Visitor" }
        }
    };
    const res = await fetcher1.fetch('qpack-deep', data);
    const json = await res.json();
    log(1, 'Response:', json);
    trackRequestStats(data, res);
});

sendArrayBtn.addEventListener('click', async () => {
    log(1, '--- Sending Arrays ---');
    const data = {
        tags: ["a", "b", "c"],
        matrix: [[1, 2], [3, 4]],
        mixed: [{ id: 1 }, { id: 2 }]
    };
    const res = await fetcher1.fetch('qpack-arr', data);
    const json = await res.json();
    log(1, 'Response:', json);
    trackRequestStats(data, res);
});

sendMixedBtn.addEventListener('click', async () => {
    log(1, '--- Sending Mixed (Stream + Meta) ---');

    // Create a stream
    const stream = new ReadableStream({
        start(c) {
            c.enqueue(new TextEncoder().encode("Hello from Stream!"));
            c.close();
        }
    });

    const data = {
        meta: { type: "stream-test", importance: "high" },
        payloadStream: stream // QpackCodec/RTCFetcher should handle this StreamRef conversion
    };

    // Note: The Receiver simply echos 'originalBody'.
    // If StreamRef logic works, the receiver will get a ReadableStream in the body.
    // However, JSONing a stream in the echo response might be tricky unless handled?
    // Wait, the echo logic: res.send({ originalBody: requestData.body })
    // If requestData.body contains a ReadableStream (which it does on receiver side),
    // sending it back means RTCFetcher will see a ReadableStream in the 'send' body.
    // It should traverse it, create a NEW StreamRef, and pipe it.
    // So the sender (peer1) receiving the response will get a NEW ReadableStream.
    // JSON.stringify can't show it, so my log(1) might show empty object or specific representation.

    const res = await fetcher1.fetch('qpack-mixed', data);
    const json = await res.json();

    // Check if the echoed stream is readable
    // @ts-ignore
    const receivedStream = json.originalBody?.payloadStream;
    if (receivedStream instanceof ReadableStream) {
        log(1, 'Success! Received echoed payloadStream as ReadableStream.');
        const r = receivedStream.getReader();
        const { value } = await r.read();
        log(1, `Stream Content: "${new TextDecoder().decode(value)}"`);
    } else {
        log(1, 'Failed: payloadStream is not a ReadableStream', receivedStream);
    }
    trackRequestStats(data, res);
});

sendRepeatedBtn.addEventListener('click', async () => {
    log(1, '--- Sending Repeated Object (Dynamic Table Test) ---');
    const data = {
        "x-custom-header": "This is a very long value that should be compressed by the dynamic table on the second send.",
        "x-id": 1,
        "x-timestamp": Date.now()
    };

    log(1, '1. Sending First Request (Should Insert to Dynamic Table)...');
    const res1 = await fetcher1.fetch('qpack-repeat', data);
    const json1 = await res1.json();
    log(1, 'Response 1:', json1);
    trackRequestStats(data, res1);

    // @ts-ignore
    const enc1 = res1.qpackStats?.requestEncodedSize || 0;
    const raw1 = JSON.stringify(data).length; // Approx
    log(1, `Req 1 Stats: Encoded ${enc1} bytes vs Raw JSON ~${raw1} bytes. Ratio: ${(enc1 / raw1).toFixed(2)}`);

    log(1, '2. Sending Second Request (Should Reference Dynamic Table)...');
    // We update timestamp to differentiate, but keep the long string same
    const data2 = { ...data, "x-id": 2, "x-timestamp": Date.now() };
    const res2 = await fetcher1.fetch('qpack-repeat', data2);
    const json2 = await res2.json();
    log(1, 'Response 2:', json2);
    trackRequestStats(data2, res2);

    // @ts-ignore
    const enc2 = res2.qpackStats?.requestEncodedSize || 0;
    const raw2 = JSON.stringify(data2).length;
    log(1, `Req 2 Stats: Encoded ${enc2} bytes vs Raw JSON ~${raw2} bytes. Ratio: ${(enc2 / raw2).toFixed(2)}`);

    if (enc2 < enc1) {
        log(1, 'SUCCESS: Request 2 is smaller than Request 1, Dynamic Table used!');
    } else {
        log(1, 'WARNING: No compression gain. Dynamic Table might not be syncing.');
    }

    log(1, 'If both requests succeeded, Dynamic Table sync is working!');
});

// Stats UI Logic
const statOriginalSize = document.getElementById('statOriginalSize') as HTMLSpanElement;
const statEncodedSize = document.getElementById('statEncodedSize') as HTMLSpanElement;
const barEncoded = document.getElementById('barEncoded') as HTMLDivElement;
const statRatio = document.getElementById('statRatio') as HTMLDivElement;
const statSavings = document.getElementById('statSavings') as HTMLDivElement;

function updateStatsUI(original: number, encoded: number) {
    statOriginalSize.innerText = `${original} B`;
    statEncodedSize.innerText = `${encoded} B`;

    // Bar width relative to original (max 100%)
    // If encoded > original (overhead), cap at 100% or show warning color?
    // Let's just create a relative bar. 
    // We treat Original as 100% width reference.

    let percentage = (encoded / original) * 100;
    if (percentage > 100) percentage = 100; // Cap visual width

    barEncoded.style.width = `${percentage}%`;

    // Ratio: Encoded / Original. (Lower is better)
    // Savings: (Original - Encoded) / Original. (Higher is better)

    const ratio = (encoded / original).toFixed(2);
    const savings = ((1 - (encoded / original)) * 100).toFixed(1);

    statRatio.innerText = `${ratio}x`;
    statSavings.innerText = `Savings: ${savings}%`;

    if (encoded > original) {
        statSavings.style.color = '#d13438'; // Red if overhead
        statSavings.innerText = `Overhead: -${savings}%`;
    } else {
        statSavings.style.color = '#28a745'; // Green
    }
}

// Visualization Logic
const refreshTableBtn = document.getElementById('refreshTableBtn') as HTMLButtonElement;
const tableBody = document.getElementById('dynamicTableBody') as HTMLTableSectionElement;

function updateDynamicTableViz() {
    // Access internal context (Hack/Extension)
    // @ts-ignore
    const context = fetcher1.qpackContext;
    if (!context) {
        console.warn("No QpackContext found on fetcher1");
        return;
    }

    // Access localTable (Encoder's view of the table)
    // @ts-ignore
    const table = context.localTable;
    // @ts-ignore
    const entries = table.getEntries(); // Use the getter we added
    // @ts-ignore
    const dropped = table.droppedCount;

    tableBody.innerHTML = '';

    // Reverse needed because entries are stored Oldest -> Newest
    // We want to show Newest (Rel 0) at top? Or typically tables show List.
    // Let's show as is (Oldest first) but with Relative Index calculation.
    // Actually RFC Rel Index 0 is Newest.

    // entries[0] = Oldest (Abs Index = dropped)
    // entries[len-1] = Newest (Abs Index = dropped + len - 1) (Rel Index = 0)

    if (entries.length === 0) {
        tableBody.innerHTML = '<tr><td colspan="5" style="text-align: center;">Empty</td></tr>';
        return;
    }

    // Iterate Newest to Oldest for display
    for (let i = entries.length - 1; i >= 0; i--) {
        const entry = entries[i];
        const absIndex = dropped + i;
        const relIndex = entries.length - 1 - i;

        const row = document.createElement('tr');
        row.innerHTML = `
            <td>${absIndex}</td>
            <td>${relIndex}</td>
            <td style="word-break: break-all; color: darkblue;">${entry.name}</td>
            <td style="word-break: break-all;">${entry.value.length > 50 ? entry.value.substring(0, 50) + "..." : entry.value}</td>
            <td>${entry.size}</td>
        `;
        tableBody.appendChild(row);
    }
}

refreshTableBtn.addEventListener('click', updateDynamicTableViz);
