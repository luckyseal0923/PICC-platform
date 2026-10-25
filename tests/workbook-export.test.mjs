import test from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import {downloadCaseWorkbook} from '../client/workbook-export.js';

test('downloaded workbook retains identifier strings, Taiwan wall time, and plain text rather than formulas',async()=>{
  const originalDocument=globalThis.document,originalCreate=URL.createObjectURL;
  let blob,downloadName,clicks=0;
  globalThis.document={createElement:()=>({set href(value){},set download(value){downloadName=value;},click(){clicks++;}})};
  URL.createObjectURL=value=>{blob=value;return originalCreate(value);};
  try{
    await downloadCaseWorkbook([{createdAt:'2026-10-01T00:05:00Z',taskId:'PICC-2610-001',patientName:'=1+1',bedNo:'001',mrn:'00123456',status:'cancelled',cancelledAt:'2026-10-02T00:10:00Z',cancelReason:'其他',cancelDetail:'測試資料',remark:'多行\n備註'}],{cancelled:'已取消'});
    assert.equal(clicks,1);assert.equal(downloadName,'PICC-案件.xlsx');
    const book=new ExcelJS.Workbook();await book.xlsx.load(await blob.arrayBuffer());
    const sheet=book.getWorksheet('案件明細');assert.equal(sheet.rowCount,2);
    assert.equal(sheet.getCell('E2').value,'00123456');assert.equal(sheet.getCell('E2').numFmt,'@');
    assert.equal(sheet.getCell('D2').value,'001');assert.equal(sheet.getCell('C2').value,'=1+1');assert.equal(sheet.getCell('C2').type,ExcelJS.ValueType.String);
    assert.equal(sheet.getCell('A2').value.toISOString(),'2026-10-01T08:05:00.000Z');assert.equal(sheet.getCell('A2').numFmt,'yyyy/mm/dd hh:mm');
    assert.equal(sheet.getCell('P2').value.toISOString(),'2026-10-02T08:10:00.000Z');assert.equal(sheet.getCell('O2').value,null);
    assert.equal(sheet.getCell('S2').value,'cancelled');assert.equal(sheet.views[0].ySplit,1);assert(sheet.autoFilter);
  }finally{globalThis.document=originalDocument;URL.createObjectURL=originalCreate;}
});
