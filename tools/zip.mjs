// A ZIP writer, because the store takes a ZIP and node does not make one.
//
// It is 60 lines because the archive is 24 small files and needs none of the
// rest of the format: no zip64, no encryption, no directory entries. What it
// does need is to be the same bytes every time it is run on the same files -
// the hash of the archive is what ties what was uploaded to a commit - so the
// timestamp every entry carries is fixed rather than taken from the disk.
import fs from 'node:fs';
import zlib from 'node:zlib';

// 1 January 2020, in the two-field format ZIP inherited from MS-DOS.
const DOS_TIME = 0;
const DOS_DATE = ((2020 - 1980) << 9) | (1 << 5) | 1;

const CRC_TABLE = (function () {
    const table = new Int32Array(256);
    for (let i = 0; i < 256; i++) {
        let c = i;
        for (let k = 0; k < 8; k++) {
            c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
        }
        table[i] = c;
    }
    return table;
})();

function crc32(buffer) {
    let c = -1;
    for (let i = 0; i < buffer.length; i++) {
        c = CRC_TABLE[(c ^ buffer[i]) & 0xFF] ^ (c >>> 8);
    }
    return (c ^ -1) >>> 0;
}

/**
 * Writes `files` - `{name, path}`, where the name is the path inside the
 * archive - to `out`. Names use forward slashes, which is what the format says
 * and what a store on any platform expects.
 */
export function writeZip(out, files) {
    const parts = [];
    const central = [];
    let offset = 0;
    for (const file of files) {
        const name = Buffer.from(file.name.split('\\').join('/'), 'utf8');
        const content = fs.readFileSync(file.path);
        const deflated = zlib.deflateRawSync(content, {level: 9});
        // A file that deflates to more than it was is stored as it is.
        const stored = deflated.length >= content.length;
        const body = stored ? content : deflated;
        const crc = crc32(content);

        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(20, 4);
        local.writeUInt16LE(0, 6);
        local.writeUInt16LE(stored ? 0 : 8, 8);
        local.writeUInt16LE(DOS_TIME, 10);
        local.writeUInt16LE(DOS_DATE, 12);
        local.writeUInt32LE(crc, 14);
        local.writeUInt32LE(body.length, 18);
        local.writeUInt32LE(content.length, 22);
        local.writeUInt16LE(name.length, 26);
        local.writeUInt16LE(0, 28);
        parts.push(local, name, body);

        const entry = Buffer.alloc(46);
        entry.writeUInt32LE(0x02014b50, 0);
        entry.writeUInt16LE(20, 4);
        entry.writeUInt16LE(20, 6);
        entry.writeUInt16LE(0, 8);
        entry.writeUInt16LE(stored ? 0 : 8, 10);
        entry.writeUInt16LE(DOS_TIME, 12);
        entry.writeUInt16LE(DOS_DATE, 14);
        entry.writeUInt32LE(crc, 16);
        entry.writeUInt32LE(body.length, 20);
        entry.writeUInt32LE(content.length, 24);
        entry.writeUInt16LE(name.length, 28);
        entry.writeUInt32LE(offset, 42);
        central.push(entry, name);

        offset += local.length + name.length + body.length;
    }
    const directory = Buffer.concat(central);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(files.length, 8);
    end.writeUInt16LE(files.length, 10);
    end.writeUInt32LE(directory.length, 12);
    end.writeUInt32LE(offset, 16);
    fs.writeFileSync(out, Buffer.concat([...parts, directory, end]));
}
