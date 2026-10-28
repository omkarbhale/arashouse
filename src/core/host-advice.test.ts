import { describe, expect, it } from "vitest";
import { SQL_ADVISED_MAX_MB, SQL_UNCAPPED_MB, adviceMessage, hostAdvice } from "./host-advice.js";

const config = { max_active: 3, min_free_ram_mb: 2048 };

describe("hostAdvice", () => {
  it("advises a SQL Server cap only when the instance is uncapped", () => {
    expect(hostAdvice({ sqlMaxServerMemoryMb: SQL_UNCAPPED_MB, leased: 0, config }).map((a) => [a.setting, a.recommended])).toEqual([
      ["sql max server memory", `${SQL_ADVISED_MAX_MB} MB`],
    ]);
    expect(hostAdvice({ sqlMaxServerMemoryMb: 12000, leased: 0, config })).toEqual([]);
    expect(hostAdvice({ leased: 0, config })).toEqual([]);
  });

  it("advises a WSL cap that gives Windows the room the leases still to come need", () => {
    const [wsl] = hostAdvice({ freeRamMb: 2500, wslMemoryMb: 16077, leased: 0, config });
    // 3 x 2048 = 6144 needed, 3644 short: 16077 - 3644 = 12433 MB, rounded down to whole GB.
    expect(wsl?.recommended).toMatch(/^at most 12 GB /);
    expect(adviceMessage(wsl!)).toMatch(/^seen a 15\.7 GB WSL VM, with 2500 MB free on Windows; recommended at most 12 GB .*; why: /);
    expect(hostAdvice({ freeRamMb: 2500, wslMemoryMb: 16077, leased: 3, config })).toEqual([]);
    expect(hostAdvice({ freeRamMb: 6144, wslMemoryMb: 16077, leased: 0, config })).toEqual([]);
  });

  it("gives no WSL advice outside WSL, or when the cap it would need starves WSL itself", () => {
    expect(hostAdvice({ freeRamMb: 100, leased: 0, config })).toEqual([]);
    expect(hostAdvice({ freeRamMb: 100, wslMemoryMb: 8192, leased: 0, config })).toEqual([]);
  });
});
