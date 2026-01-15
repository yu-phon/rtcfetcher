export class RTCFetcherError extends Error {
    constructor(message: string, public code: string, public cause?: any) {
        super(message);
        this.name = 'RTCFetcherError';

        // Errorスタックトレースの保持（TypeScript用）
        if (Error.captureStackTrace) {
            Error.captureStackTrace(this, RTCFetcherError);
        }
    }
}

export class RTCTimeoutError extends RTCFetcherError {
    constructor(message: string = 'Request timed out') {
        super(message, 'TIMEOUT');
        this.name = 'RTCTimeoutError';
    }
}

export class RTCConnectionError extends RTCFetcherError {
    constructor(message: string = 'Connection lost') {
        super(message, 'CONNECTION_LOST');
        this.name = 'RTCConnectionError';
    }
}

export class RTCSerializationError extends RTCFetcherError {
    constructor(message: string = 'Serialization failed', cause?: any) {
        super(message, 'SERIALIZATION_FAILED', cause);
        this.name = 'RTCSerializationError';
    }
}
