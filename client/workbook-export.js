import ExcelJS from "exceljs";

const dateFormat=new Intl.DateTimeFormat("sv-SE",{timeZone:"Asia/Taipei",year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",hourCycle:"h23"});
function taipeiExcelDate(value){
  if(!value)return null;const date=new Date(value);if(Number.isNaN(date.getTime()))return null;
  const parts=Object.fromEntries(dateFormat.formatToParts(date).map(part=>[part.type,part.value]));
  return new Date(Date.UTC(+parts.year,+parts.month-1,+parts.day,+parts.hour,+parts.minute));
}

export async function downloadCaseWorkbook(tasks,labels){
  const book=new ExcelJS.Workbook();book.creator="PICC 團隊平台";book.created=new Date();
  const sheet=book.addWorksheet("案件明細",{views:[{state:"frozen",ySplit:1}],pageSetup:{orientation:"landscape",fitToPage:true,fitToWidth:1,fitToHeight:0}});
  const columns=[
    ["起單時間（臺灣）","createdAt",22],["案件編號","taskId",20],["病人姓名","patientName",18],["床號","bedNo",13],
    ["病歷號","mrn",16],["案件狀態","status",17],["接單者","claimedBy",17],["實際施打者","operatorName",17],
    ["困難度","difficulty",16],["備註","remark",48],["管路種類","catheterType",17],["管路長度(cm)","catheterLength",17],
    ["部位","insertionSite",16],["血管","vein",16],["完成時間（臺灣）","completedAt",22],["取消時間（臺灣）","cancelledAt",22],
    ["取消原因","cancelReason",22],["取消說明","cancelDetail",40],["狀態代碼","statusCode",20]
  ];
  sheet.columns=columns.map(([header,key,width])=>({header,key,width}));
  for(const task of tasks){
    const data={...task,mrn:String(task.mrn??""),bedNo:String(task.bedNo??""),status:labels[task.status]||task.status,statusCode:task.status};
    for(const key of ["createdAt","completedAt","cancelledAt"])data[key]=taipeiExcelDate(task[key]);
    const row=sheet.addRow(data);row.font={name:"Microsoft JhengHei",size:11};row.height=Math.min(300,Math.max(36,Math.ceil(String(task.remark||"").length/24)*16,Math.ceil(String(task.cancelDetail||"").length/20)*16));row.alignment={vertical:"top",wrapText:true};
    for(const key of ["createdAt","completedAt","cancelledAt"])row.getCell(key).numFmt="yyyy/mm/dd hh:mm";
    for(const key of ["mrn","taskId","bedNo","statusCode"])row.getCell(key).numFmt="@";
    if(["困難","非常困難"].includes(task.difficulty))row.getCell("difficulty").font={bold:true,color:{argb:"FF99441A"}};
    if(row.number%2===0)row.fill={type:"pattern",pattern:"solid",fgColor:{argb:"FFF1F6F7"}};
  }
  sheet.getRow(1).height=32;sheet.getRow(1).font={name:"Microsoft JhengHei",size:11,bold:true,color:{argb:"FFFFFFFF"}};
  sheet.getRow(1).fill={type:"pattern",pattern:"solid",fgColor:{argb:"FF12665D"}};sheet.getRow(1).alignment={vertical:"middle",wrapText:true};
  sheet.autoFilter={from:{row:1,column:1},to:{row:Math.max(1,sheet.rowCount),column:columns.length}};
  sheet.getColumn("mrn").numFmt="@";
  const buffer=await book.xlsx.writeBuffer(),url=URL.createObjectURL(new Blob([buffer],{type:"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"}));
  const link=document.createElement("a");link.href=url;link.download="PICC-案件.xlsx";link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
}
