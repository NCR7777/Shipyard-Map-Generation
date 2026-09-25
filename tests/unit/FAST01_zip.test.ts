import { expect, it } from 'vitest';
import { storedZip } from '../../src/adapters/storedZip';
it('writes standard ZIP method 0, UTF-8 names and independent CRC32 without changing payload',()=>{
  const bytes=new TextEncoder().encode('123456789'),name='图像/原图.txt',zip=storedZip([{name,bytes}]),view=new DataView(zip.buffer);
  expect(view.getUint32(0,true)).toBe(0x04034b50);expect(view.getUint16(6,true)).toBe(0x0800);expect(view.getUint16(8,true)).toBe(0);expect(view.getUint32(14,true)).toBe(0xcbf43926);
  const length=view.getUint16(26,true);expect(new TextDecoder().decode(zip.slice(30,30+length))).toBe(name);expect(zip.slice(30+length,30+length+9)).toEqual(bytes);
  expect(view.getUint32(zip.length-22,true)).toBe(0x06054b50);expect(view.getUint16(zip.length-12,true)).toBe(1);
  expect(()=>storedZip([{name:'../outside',bytes}])).toThrow('ZIP_ENTRY_PATH');expect(()=>storedZip([{name:'a',bytes},{name:'a',bytes}])).toThrow('ZIP_ENTRY_PATH');
});
