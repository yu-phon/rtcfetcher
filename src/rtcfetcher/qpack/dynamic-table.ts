
// QPACK Dynamic Table Implementation
// RFC 9204 Section 2.2. Dynamic Table

export interface DynamicTableEntry {
    name: string;
    value: string;
    size: number;
}

export class DynamicTable {
    // Entries are stored in insertion order.
    // The "absolute index" increases with each insertion.
    // RFC 9204 uses absolute indices to reference entries consistently.
    // In this array:
    // entries[0] is the OLDEST entry (smallest absolute index still in table).
    // entries[length-1] is the NEWEST entry (largest absolute index).
    //
    // However, QPACK relative indexing is 0-based from the newest.
    // Relative Index 0 -> Newest Entry
    // Relative Index 1 -> 2nd Newest Entry
    private entries: DynamicTableEntry[] = [];

    // Total number of insertions made to the dynamic table (Lifetime)
    // This corresponds to 'inserted_count' in RFC.
    private insertedCount: number = 0;

    // Current size of the table in bytes
    private currentSize: number = 0;

    // Capacity limit (Default 4096 bytes, can be updated via SET_DYNAMIC_TABLE_CAPACITY)
    private capacity: number;

    // The index of the first entry in 'entries' relative to absolute index 0.
    // If we have dropped N entries, the first entry in 'entries' has absolute index N.
    private droppedCount: number = 0;

    constructor(capacity: number = 4096) {
        this.capacity = capacity;
    }

    public getInsertedCount(): number {
        return this.insertedCount;
    }

    public getEntries(): DynamicTableEntry[] {
        // Return a copy to prevent external mutation
        return [...this.entries];
    }

    public setCapacity(capacity: number) {
        this.capacity = capacity;
        this.evict();
    }

    private ENTRY_OVERHEAD = 32;

    public insert(name: string, value: string): void {
        const size = name.length + value.length + this.ENTRY_OVERHEAD;

        // If entry is larger than capacity, it can't be added.
        // RFC says: "It is not added to the dynamic table. The method succeeds..."
        // But previous entries might need eviction to make space?
        // Actually RFC 7541 (HPACK) says if size > capacity, table is cleared. QPACK similar.
        if (size > this.capacity) {
            this.clear();
            // Just increment count? RFC 9204 3.2.2:
            // "If the size of the entry is greater than the valid capacity, the entry is not added..."
            // "The number of insertions is incremented by 1."
            this.insertedCount++;
            return;
        }

        this.evict(this.capacity - size);

        this.entries.push({ name, value, size });
        this.currentSize += size;
        this.insertedCount++;
    }

    public duplicate(absoluteIndex: number): void {
        const entry = this.getEntry(absoluteIndex);
        if (!entry) throw new Error(`Cannot duplicate: Entry ${absoluteIndex} not found`);
        this.insert(entry.name, entry.value);
    }

    private evict(targetSize: number = this.capacity): void {
        while (this.currentSize > targetSize && this.entries.length > 0) {
            const entry = this.entries.shift()!; // Remove OLDEST
            this.currentSize -= entry.size;
            this.droppedCount++;
        }
    }

    public clear(): void {
        // droppedCount catches up to insertedCount?
        // Effectively we drop everything currently held.
        // But we DO NOT reset insertedCount because absolute indices must be monotonic.
        this.droppedCount += this.entries.length;
        this.entries = [];
        this.currentSize = 0;
    }

    // Get entry by Absolute Index
    public getEntry(absoluteIndex: number): DynamicTableEntry | undefined {
        if (absoluteIndex < this.droppedCount) return undefined; // Evicted
        const arrayIndex = absoluteIndex - this.droppedCount;
        if (arrayIndex >= this.entries.length) return undefined; // Future?
        return this.entries[arrayIndex];
    }

    // Get entry by Relative Index (0 = Newest)
    public getEntryRelative(relativeIndex: number): DynamicTableEntry | undefined {
        // relative 0 -> entries[length-1]
        // relative k -> entries[length-1-k]
        const arrayIndex = this.entries.length - 1 - relativeIndex;
        if (arrayIndex < 0) return undefined;
        return this.entries[arrayIndex];
    }

    // Convert Absolute <-> Relative
    // Base Index is usually the Insert Count.
    // Relative Index = Base Index - 1 - Absolute Index
    // specific to the encoder/decoder state during a block processing.
    // This method is generic for table lookup.

    // Search for matching name (and value)
    // Returns { index: absoluteIndex, nameMatch: boolean, valueMatch: boolean }
    public search(name: string, value: string): { index: number, nameMatch: boolean, valueMatch: boolean } | null {
        let bestMatch: { index: number, nameMatch: boolean, valueMatch: boolean } | null = null;

        // Iterate from NEWEST to OLDEST (optimization: newer likely used)
        for (let i = this.entries.length - 1; i >= 0; i--) {
            const entry = this.entries[i];
            const absIndex = this.droppedCount + i;

            if (entry.name === name) {
                if (entry.value === value) {
                    // Exact match - Return immediately
                    return { index: absIndex, nameMatch: true, valueMatch: true };
                }
                if (!bestMatch) {
                    bestMatch = { index: absIndex, nameMatch: true, valueMatch: false };
                }
            }
        }
        return bestMatch;
    }
}
