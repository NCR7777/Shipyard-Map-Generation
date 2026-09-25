/** Minimal uncompressed ZIP writer. Original raster bytes are stored verbatim. No filesystem paths are followed. */
export function storedZip(entries: readonly { name: string; bytes: Uint8Array }[]): Uint8Array {
  if (entries.length > 65535) throw new Error('ZIP_ENTRY_LIMIT');
  const encoder=new TextEncoder(),names=new Set<string>(),locals:Uint8Array[]=[],centrals:Uint8Array[]=[];let offset=0,total=0;
  const crc=(bytes:Uint8Array)=>{let value=0xffffffff;for(const byte of bytes){value^=byte;for(let i=0;i<8;i++)value=(value>>>1)^((value&1)?0xedb88320:0);}return (value^0xffffffff)>>>0;};
  for(const entry of entries){
    if(!entry.name||entry.name.startsWith('/')||entry.name.includes('\\')||entry.name.split('/').some(p=>p==='..'||p==='.'||!p)||(entry.name.includes(':')||[...entry.name].some(char=>char.charCodeAt(0)<32))||names.has(entry.name))throw Error('ZIP_ENTRY_PATH');
    names.add(entry.name);const name=encoder.encode(entry.name),size=entry.bytes.byteLength;total+=size;
    if(name.length>65535||total>256*1024*1024)throw Error('ZIP_SIZE_LIMIT: 补标包超过 256 MiB，请按项目分包。');
    const checksum=crc(entry.bytes),local=new Uint8Array(30+name.length),l=new DataView(local.buffer);
    l.setUint32(0,0x04034b50,true);l.setUint16(4,20,true);l.setUint16(6,0x0800,true);l.setUint16(12,33,true);l.setUint32(14,checksum,true);l.setUint32(18,size,true);l.setUint32(22,size,true);l.setUint16(26,name.length,true);local.set(name,30);
    const central=new Uint8Array(46+name.length),c=new DataView(central.buffer);c.setUint32(0,0x02014b50,true);c.setUint16(4,20,true);c.setUint16(6,20,true);c.setUint16(8,0x0800,true);c.setUint16(14,33,true);c.setUint32(16,checksum,true);c.setUint32(20,size,true);c.setUint32(24,size,true);c.setUint16(28,name.length,true);c.setUint32(42,offset,true);central.set(name,46);
    locals.push(local,entry.bytes);centrals.push(central);offset+=local.length+size;
  }
  const centralSize=centrals.reduce((sum,p)=>sum+p.length,0),end=new Uint8Array(22),e=new DataView(end.buffer);e.setUint32(0,0x06054b50,true);e.setUint16(8,entries.length,true);e.setUint16(10,entries.length,true);e.setUint32(12,centralSize,true);e.setUint32(16,offset,true);
  const result=new Uint8Array(offset+centralSize+end.length);let cursor=0;for(const part of [...locals,...centrals,end]){result.set(part,cursor);cursor+=part.length;}return result;
}
