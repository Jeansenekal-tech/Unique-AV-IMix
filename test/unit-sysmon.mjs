// Unit test: GPU utilisation parsing from macOS `ioreg -c IOAccelerator`.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { parseIoreg } = require('../main/sysmon.js');

let failures = 0;
const check = (cond, msg) => {
  console.log(`${cond ? '✔' : '✖'} ${msg}`);
  if (!cond) failures++;
};

const appleSilicon = `+-o AGXAcceleratorG13X  <class AGXAcceleratorG13X, id 0x100000a2d, registered, matched, active, busy 0 (2 ms), retain 56>
    {
      "IOClass" = "AGXAcceleratorG13X"
      "model" = "Apple M1 Pro"
      "PerformanceStatistics" = {"In use system memory (driver)"=0,"Alloc system memory"=2179153920,"Tiler Utilization %"=5,"recoveryCount"=0,"Renderer Utilization %"=31,"Device Utilization %"=37,"SplitSceneCount"=0,"In use system memory"=734003200}
    }`;
const intelPlusAmd = `+-o IntelAccelerator  <class IntelAccelerator>
    {
      "model" = <"Intel UHD Graphics 630">
      "PerformanceStatistics" = {"Device Utilization %"=4,"In use system memory"=104857600}
    }
+-o AMDRadeonX6000_AMDNavi14GraphicsAccelerator  <class AMDRadeonX6000_AMDNavi14GraphicsAccelerator>
    {
      "model" = <"AMD Radeon Pro 5500M">
      "PerformanceStatistics" = {"Device Utilization %"=62,"In use system memory"=52428800}
    }`;

const a = parseIoreg(appleSilicon);
check(a && a.percent === 37, `Apple Silicon utilisation (${a?.percent}%)`);
check(a && a.name === 'Apple M1 Pro', `Apple Silicon model name (${a?.name})`);
check(a && a.memoryMB === 700, `GPU memory in use (${a?.memoryMB} MB)`);
const b = parseIoreg(intelPlusAmd);
check(b && b.percent === 62, `dual-GPU Mac reports the busiest GPU (${b?.percent}%)`);
check(parseIoreg('') === null && parseIoreg('nothing here') === null, 'no GPU data → null (shown as n/a)');

console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
