
// Huffman tables for QPACK

export const huffman_codes = new Uint32Array([
    0x1ff8,//(0)
    0x7fffd8,//(1)
    0xfffffe2,//(2)
    0xfffffe3,//(3)
    0xfffffe4,//(4)
    0xfffffe5,//(5)
    0xfffffe6,//(6)
    0xfffffe7,//(7)
    0xfffffe8,//(8)
    0xffffea,//(9)
    0x3ffffffc,//(10)
    0xfffffe9,//(11)
    0xfffffea,//(12)
    0x3ffffffd,//(13)
    0xfffffeb,//(14)
    0xfffffec,//(15)
    0xfffffed,//(16)
    0xfffffee,//(17)
    0xfffffef,//(18)
    0xffffff0,//(19)
    0xffffff1,//(20)
    0xffffff2,//(21)
    0x3ffffffe,//(22)
    0xffffff3,//(23)
    0xffffff4,//(24)
    0xffffff5,//(25)
    0xffffff6,//(26)
    0xffffff7,//(27)
    0xffffff8,//(28)
    0xffffff9,//(29)
    0xffffffa,//(30)
    0xffffffb,//(31)
    0x14,//' ' (32)
    0x3f8,//'!' (33)
    0x3f9,//'"' (34)
    0xffa,//'#' (35)
    0x1ff9,//'$' (36)
    0x15,//'%' (37)
    0xf8,//'&' (38)
    0x7fa,//''' (39)
    0x3fa,//'(' (40)
    0x3fb,//')' (41)
    0xf9,//'*' (42)
    0x7fb,//'+' (43)
    0xfa,//',' (44)
    0x16,//'-' (45)
    0x17,//'.' (46)
    0x18,//'/' (47)
    0x0,//'0' (48)
    0x1,//'1' (49)
    0x2,//'2' (50)
    0x19,//'3' (51)
    0x1a,//'4' (52)
    0x1b,//'5' (53)
    0x1c,//'6' (54)
    0x1d,//'7' (55)
    0x1e,//'8' (56)
    0x1f,//'9' (57)
    0x5c,//':' (58)
    0xfb,//';' (59)
    0x7ffc,//'<' (60)
    0x20,//'=' (61)
    0xffb,//'>' (62)
    0x3fc,//'?' (63)
    0x1ffa,//'@' (64)
    0x21,//'A' (65)
    0x5d,//'B' (66)
    0x5e,//'C' (67)
    0x5f,//'D' (68)
    0x60,//'E' (69)
    0x61,//'F' (70)
    0x62,//'G' (71)
    0x63,//'H' (72)
    0x64,//'I' (73)
    0x65,//'J' (74)
    0x66,//'K' (75)
    0x67,//'L' (76)
    0x68,//'M' (77)
    0x69,//'N' (78)
    0x6a,//'O' (79)
    0x6b,//'P' (80)
    0x6c,//'Q' (81)
    0x6d,//'R' (82)
    0x6e,//'S' (83)
    0x6f,//'T' (84)
    0x70,//'U' (85)
    0x71,//'V' (86)
    0x72,//'W' (87)
    0xfc,//'X' (88)
    0x73,//'Y' (89)
    0xfd,//'Z' (90)
    0x1ffb,//'[' (91)
    0x7fff0,//'\' (92)
    0x1ffc,//']' (93)
    0x3ffc,//'^' (94)
    0x22,//'_' (95)
    0x7ffd,//'`' (96)
    0x3,//'a' (97)
    0x23,//'b' (98)
    0x4,//'c' (99)
    0x24,//'d' (100)
    0x5,//'e' (101)
    0x25,//'f' (102)
    0x26,//'g' (103)
    0x27,//'h' (104)
    0x6,//'i' (105)
    0x74,//'j' (106)
    0x75,//'k' (107)
    0x28,//'l' (108)
    0x29,//'m' (109)
    0x2a,//'n' (110)
    0x7,//'o' (111)
    0x2b,//'p' (112)
    0x76,//'q' (113)
    0x2c,//'r' (114)
    0x8,//'s' (115)
    0x9,//'t' (116)
    0x2d,//'u' (117)
    0x77,//'v' (118)
    0x78,//'w' (119)
    0x79,//'x' (120)
    0x7a,//'y' (121)
    0x7b,//'z' (122)
    0x7ffe,//'{' (123)
    0x7fc,//'|' (124)
    0x3ffd,//'}' (125)
    0x1ffd,//'~' (126)
    0xffffffc,//(127)
    0xfffe6,//(128)
    0x3fffd2,//(129)
    0xfffe7,//(130)
    0xfffe8,//(131)
    0x3fffd3,//(132)
    0x3fffd4,//(133)
    0x3fffd5,//(134)
    0x7fffd9,//(135)
    0x3fffd6,//(136)
    0x7fffda,//(137)
    0x7fffdb,//(138)
    0x7fffdc,//(139)
    0x7fffdd,//(140)
    0x7fffde,//(141)
    0xffffeb,//(142)
    0x7fffdf,//(143)
    0xffffec,//(144)
    0xffffed,//(145)
    0x3fffd7,//(146)
    0x7fffe0,//(147)
    0xffffee,//(148)
    0x7fffe1,//(149)
    0x7fffe2,//(150)
    0x7fffe3,//(151)
    0x7fffe4,//(152)
    0x1fffdc,//(153)
    0x3fffd8,//(154)
    0x7fffe5,//(155)
    0x3fffd9,//(156)
    0x7fffe6,//(157)
    0x7fffe7,//(158)
    0xffffef,//(159)
    0x3fffda,//(160)
    0x1fffdd,//(161)
    0xfffe9,//(162)
    0x3fffdb,//(163)
    0x3fffdc,//(164)
    0x7fffe8,//(165)
    0x7fffe9,//(166)
    0x1fffde,//(167)
    0x7fffea,//(168)
    0x3fffdd,//(169)
    0x3fffde,//(170)
    0xfffff0,//(171)
    0x1fffdf,//(172)
    0x3fffdf,//(173)
    0x7fffeb,//(174)
    0x7fffec,//(175)
    0x1fffe0,//(176)
    0x1fffe1,//(177)
    0x3fffe0,//(178)
    0x1fffe2,//(179)
    0x7fffed,//(180)
    0x3fffe1,//(181)
    0x7fffee,//(182)
    0x7fffef,//(183)
    0xfffea,//(184)
    0x3fffe2,//(185)
    0x3fffe3,//(186)
    0x3fffe4,//(187)
    0x7ffff0,//(188)
    0x3fffe5,//(189)
    0x3fffe6,//(190)
    0x7ffff1,//(191)
    0x3ffffe0,//(192)
    0x3ffffe1,//(193)
    0xfffeb,//(194)
    0x7fff1,//(195)
    0x3fffe7,//(196)
    0x7ffff2,//(197)
    0x3fffe8,//(198)
    0x1ffffec,//(199)
    0x3ffffe2,//(200)
    0x3ffffe3,//(201)
    0x3ffffe4,//(202)
    0x7ffffde,//(203)
    0x7ffffdf,//(204)
    0x3ffffe5,//(205)
    0xfffff1,//(206)
    0x1ffffed,//(207)
    0x7fff2,//(208)
    0x1fffe3,//(209)
    0x3ffffe6,//(210)
    0x7ffffe0,//(211)
    0x7ffffe1,//(212)
    0x3ffffe7,//(213)
    0x7ffffe2,//(214)
    0xfffff2,//(215)
    0x1fffe4,//(216)
    0x1fffe5,//(217)
    0x3ffffe8,//(218)
    0x3ffffe9,//(219)
    0xffffffd,//(220)
    0x7ffffe3,//(221)
    0x7ffffe4,//(222)
    0x7ffffe5,//(223)
    0xfffec,//(224)
    0xfffff3,//(225)
    0xfffed,//(226)
    0x1fffe6,//(227)
    0x3fffe9,//(228)
    0x1fffe7,//(229)
    0x1fffe8,//(230)
    0x7ffff3,//(231)
    0x3fffea,//(232)
    0x3fffeb,//(233)
    0x1ffffee,//(234)
    0x1ffffef,//(235)
    0xfffff4,//(236)
    0xfffff5,//(237)
    0x3ffffea,//(238)
    0x7ffff4,//(239)
    0x3ffffeb,//(240)
    0x7ffffe6,//(241)
    0x3ffffec,//(242)
    0x3ffffed,//(243)
    0x7ffffe7,//(244)
    0x7ffffe8,//(245)
    0x7ffffe9,//(246)
    0x7ffffea,//(247)
    0x7ffffeb,//(248)
    0xffffffe,//(249)
    0x7ffffec,//(250)
    0x7ffffed,//(251)
    0x7ffffee,//(252)
    0x7ffffef,//(253)
    0x7fffff0,//(254)
    0x3ffffee,//(255)
    0x3fffffff,//EOS (256)
]);

export const huffman_bits = new Uint8Array([13, 23, 28, 28, 28, 28, 28, 28, 28, 24, 30, 28, 28, 30, 28, 28, 28, 28, 28, 28, 28, 28, 30, 28, 28, 28, 28, 28, 28, 28, 28, 28, 6, 10, 10, 12, 13, 6, 8, 11, 10, 10, 8, 11, 8, 6, 6, 6, 5, 5, 5, 6, 6, 6, 6, 6, 6, 6, 7, 8, 15, 6, 12, 10, 13, 6, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 8, 7, 8, 13, 19, 13, 14, 6, 15, 5, 6, 5, 6, 5, 6, 6, 6, 5, 7, 7, 6, 6, 6, 5, 6, 7, 6, 5, 5, 6, 7, 7, 7, 7, 7, 15, 11, 14, 13, 28, 20, 22, 20, 20, 22, 22, 22, 23, 22, 23, 23, 23, 23, 23, 24, 23, 24, 24, 22, 23, 24, 23, 23, 23, 23, 21, 22, 23, 22, 23, 23, 24, 22, 21, 20, 22, 22, 23, 23, 21, 23, 22, 22, 24, 21, 22, 23, 23, 21, 21, 22, 21, 23, 22, 23, 23, 20, 22, 22, 22, 23, 22, 22, 23, 26, 26, 20, 19, 22, 23, 22, 25, 26, 26, 26, 27, 27, 26, 24, 25, 19, 21, 26, 27, 27, 26, 27, 24, 21, 21, 26, 26, 28, 27, 27, 27, 20, 24, 20, 21, 22, 21, 21, 23, 22, 22, 25, 25, 24, 24, 26, 23, 26, 27, 26, 26, 27, 27, 27, 27, 27, 28, 27, 27, 27, 27, 27, 26, 30]);

interface HuffmanNode {
    [bit: number]: HuffmanNode;
    symbol?: number;
}

function buildHuffmanDecodeTrie(): HuffmanNode {
    const root: HuffmanNode = {};
    for (let i = 0; i < huffman_codes.length; i++) {
        const code = huffman_codes[i];
        const length = huffman_bits[i];
        let node = root;
        for (let j = length - 1; j >= 0; j--) {
            const bit = (code >> j) & 1;
            if (!node[bit]) node[bit] = {};
            node = node[bit];
        }
        node.symbol = i;
    }
    return root;
}

export const huffman_flat_decode_tables = buildHuffmanDecodeTrie();

export function decodeHuffman(buf: Uint8Array): string {
    const output: number[] = [];
    let node = huffman_flat_decode_tables;
    let current = 0;
    let nbits = 0;

    for (let i = 0; i < buf.length; i++) {
        current = (current << 8) | buf[i];
        nbits += 8;

        while (nbits > 0) {
            const bit = (current >> (nbits - 1)) & 1;
            const nextNode = node[bit];
            if (!nextNode) throw new Error("Invalid Huffman encoding");
            node = nextNode;
            nbits--;

            if (node.symbol !== undefined) {
                output.push(node.symbol);
                node = huffman_flat_decode_tables;
            }
        }
    }

    // Padding check: must be all 1s
    const padding = (1 << nbits) - 1;
    if ((current & padding) !== padding) {
        throw new Error("Invalid Huffman padding");
    }

    return new TextDecoder().decode(Uint8Array.from(output));
}

export function huffmanEncode(text: string): Uint8Array {
    const input = new TextEncoder().encode(text);
    let bitBuffer = 0;
    let bitLen = 0;
    const output: number[] = [];

    for (let i = 0; i < input.length; i++) {
        const sym = input[i];
        const code = huffman_codes[sym];
        const nbits = huffman_bits[sym];

        // Note: Javascript bitwise shifts preserve 32-bit signed integers.
        // nbits can be up to 30. bitBuf might overflow 32-bit int.
        // We should use BigInt if bitBuffer exceeds 32 bits, but here bitBuffer should be flushed.
        // Actually, bitLen accumulates. Wait.
        // In the original JS:
        // bitBuffer = (bitBuffer << nbits) | code;
        // This is problematic if bitBuffer exceeds 32 bits.
        // Let's rewrite using BigInt for safety or careful flushing.
        // Since original was JS 'number' (double), it handle up to 53 bits integer.
        // Typescript treats number as double too.

        bitBuffer = (bitBuffer * Math.pow(2, nbits)) + code;
        bitLen += nbits;

        while (bitLen >= 8) {
            bitLen -= 8;
            output.push(Math.floor(bitBuffer / Math.pow(2, bitLen)) & 0xff);
            // clear bits
            bitBuffer = bitBuffer % Math.pow(2, bitLen);
        }
    }

    if (bitLen > 0) {
        // Pad with 1s
        bitBuffer = (bitBuffer * Math.pow(2, 8 - bitLen)) + ((1 << (8 - bitLen)) - 1);
        output.push(bitBuffer & 0xff);
    }

    return new Uint8Array(output);
}
