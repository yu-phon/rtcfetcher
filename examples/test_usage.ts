import { RTCFetcher } from '../src';

// Loopback example setup
async function runExample() {
    const pc1 = new RTCPeerConnection();
    const pc2 = new RTCPeerConnection();

    // ICE candidates
    pc1.onicecandidate = e => e.candidate && pc2.addIceCandidate(e.candidate);
    pc2.onicecandidate = e => e.candidate && pc1.addIceCandidate(e.candidate);

    // Create fetcher instances
    const fetcher1 = new RTCFetcher(pc1);
    const fetcher2 = new RTCFetcher(pc2);

    // Setup request handling on receiver (fetcher2)
    const reader = fetcher2.incomingRequests.getReader();
    (async () => {
        while (true) {
            const { done, value: req } = await reader.read();
            if (done) break;

            console.log('Received request for endpoint:', req.endpoint);
            const { req: requestData, res } = await req.open();

            console.log('Request Headers/Body:', requestData);

            // Send response
            res.send({ message: 'Hello from pc2!', original: requestData.body });
        }
    })();

    // Connect peers
    const offer = await pc1.createOffer();
    await pc1.setLocalDescription(offer);
    await pc2.setRemoteDescription(offer);
    const answer = await pc2.createAnswer();
    await pc2.setLocalDescription(answer);
    await pc1.setRemoteDescription(answer);

    // Wait for connection
    await fetcher1.opened;
    console.log('Fetcher1 opened!');

    // Perform fetch
    console.log('Fetching...');
    const response = await fetcher1.fetch('echo', { data: 'Hello from pc1' });
    const json = await response.json();
    console.log('Response:', json);

    // Cleanup
    pc1.close();
    pc2.close();
}

runExample().catch(console.error);
