
export class ProtocolHandler {
    private static readonly PREFIX_REQUEST = 'req::';
    private static readonly LABEL_STREAM = 'stream';
    private static readonly LABEL_RES_STREAM = 'res-stream';
    // Import from constants.ts is tricky due to project structure. Hardcoding for now as it is a protocol constant.
    private static readonly LABEL_POOLED = '__pooled__';

    public static isStreamChannel(label: string): boolean {
        return label === this.LABEL_STREAM || label === this.LABEL_RES_STREAM || label === this.LABEL_POOLED;
    }

    public static isRequestChannel(label: string): boolean {
        return label.startsWith(this.PREFIX_REQUEST) || (!this.isStreamChannel(label) && label !== 'default');
    }

    public static parseRequestLabel(label: string | undefined): string {
        if (!label) return 'default';
        if (label.startsWith(this.PREFIX_REQUEST)) {
            return label.substring(this.PREFIX_REQUEST.length);
        }
        return label;
    }

    public static formatRequestLabel(endpoint: string): string {
        return this.PREFIX_REQUEST + endpoint;
    }

    public static get REQUEST_PREFIX(): string {
        return this.PREFIX_REQUEST;
    }

    public static get STREAM_LABEL(): string {
        return this.LABEL_STREAM;
    }

    public static get RES_STREAM_LABEL(): string {
        return this.LABEL_RES_STREAM;
    }
}
