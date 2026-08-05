// The foundations were never measured, and that is why the cause of the pool's scaling failure was
// misattributed three times in a day. These parsers are where a foundation measurement goes wrong, so
// each test pins a mistake that was actually made or narrowly avoided.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseVmStat, parseIostat, parseLoadAverage, parseProcessMemory, diffHost } from "./host-metrics.mjs";

const VM_STAT = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                                6553.
Pages active:                            700000.
Pages inactive:                          760000.
Pages speculative:                         1000.
Pages wired down:                        314572.
Pages purgeable:                            100.
Pageins:                              702363720.
Pageouts:                              18761050.
Pages occupied by compressor:            511180.`;

test("the page size is read from the output, never assumed", () => {
  // 16 KB on Apple Silicon, 4 KB on Intel. Hardcoding 4096 understates every figure here by 4x.
  const m = parseVmStat(VM_STAT)!;
  assert.equal(m.freeMb, 102, "6553 pages x 16384 bytes = ~102 MB");
  assert.equal(m.compressorMb, 7987, "511180 pages x 16384 = ~7.8 GB held compressed");
});

test("compressor size is reported, because it is where the guests' memory actually went", () => {
  // Three guests charged 17.4 GB held 3.8 GB resident, with 7.8 GB in the compressor. Without this
  // field the host looks like it is out of memory when it is absorbing pressure successfully.
  assert.ok(parseVmStat(VM_STAT)!.compressorMb > 7000);
});

test("unparseable vm_stat output is null, not zeroes", () => {
  // Zeroes would read as "a host with no memory pressure", which is the dangerous wrong answer.
  assert.equal(parseVmStat("not vm_stat output"), null);
});

test("iostat uses the SECOND sample, because the first is a since-boot average", () => {
  // The mistake this prevents: reporting a busy disk as idle. The first row averages since boot, so on
  // a machine that has been up for days it is essentially always near zero.
  const out = `              disk0
    KB/t  tps  MB/s
    8.00    2  0.02
  128.00  400 50.00`;
  const [disk] = parseIostat(out);
  assert.equal(disk.device, "disk0");
  assert.equal(disk.mbPerSecond, 50, "must be the live sample, not the 0.02 since-boot average");
  assert.equal(disk.transfersPerSecond, 400);
});

test("multiple disks are reported separately", () => {
  const out = `              disk0             disk4
    KB/t  tps  MB/s     KB/t  tps  MB/s
    8.00    2  0.02     4.00    1  0.01
  128.00  400 50.00    16.00   20  0.31`;
  const disks = parseIostat(out);
  assert.equal(disks.length, 2);
  assert.equal(disks[1].device, "disk4");
  assert.equal(disks[1].mbPerSecond, 0.31);
});

test("iostat output with no disk header yields an empty list", () => {
  assert.deepEqual(parseIostat("iostat: command not found"), []);
});

test("load averages parse", () => {
  assert.deepEqual(parseLoadAverage("{ 8.37 6.99 5.42 }"), { one: 8.37, five: 6.99, fifteen: 5.42 });
  assert.equal(parseLoadAverage(""), null);
});

test("process memory reports RESIDENT size, which is the number that was misread all along", () => {
  // top's memory column is phys_footprint and counts compressed/swapped pages. RSS is occupancy.
  const ps = ` 28391 1640448 QEMULauncher\n  1234   40960 Finder\n 30060 1338368 QEMULauncher`;
  const procs = parseProcessMemory(ps, "QEMU");
  assert.equal(procs.length, 2, "only matching processes");
  assert.equal(procs[0].residentMb, 1602);
  assert.equal(procs[1].residentMb, 1307);
});

test("paging is reported as a delta, so stale swap cannot masquerade as live pressure", () => {
  // 6.6 GB of swap left from an incident hours earlier looks identical to a host swapping right now
  // unless you diff the counters. That distinction cost an afternoon.
  const before = { memory: { pageouts: 1000, pageins: 500, compressorMb: 100, freeMb: 200 }, processes: [] };
  const after  = { memory: { pageouts: 1000, pageins: 900, compressorMb: 120, freeMb: 150 }, processes: [] };
  const quiet = diffHost(before as never, after as never);
  assert.equal(quiet.pageoutsDelta, 0);
  assert.equal(quiet.swappingDuringRun, false, "high absolute swap with no new pageouts is NOT swapping");

  const busy = diffHost(before as never, { ...after, memory: { ...after.memory, pageouts: 1500 } } as never);
  assert.equal(busy.pageoutsDelta, 500);
  assert.equal(busy.swappingDuringRun, true);
});

test("resident totals sum only the matched processes", () => {
  const after = { memory: { pageouts: 0, pageins: 0, compressorMb: 0, freeMb: 0 },
                  processes: [{ pid: 1, residentMb: 1600, command: "q" }, { pid: 2, residentMb: 900, command: "q" }] };
  assert.equal(diffHost({ memory: { pageouts: 0, pageins: 0 }, processes: [] } as never, after as never).residentMbTotal, 2500);
});
