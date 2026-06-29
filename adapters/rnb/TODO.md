# rnb adapter — TODO / 现状

Run & Bun（基于 pokeemerald-expansion 的 Emerald 魔改）适配器。

## 已完成

- **队伍读取**：Emerald 地址（`gPlayerParty = 0x02023A98`），按槽位逐只校验；地址校验不过时自动全盘扫描 EWRAM 兜底。
- **PC 盒子读取**：`gPokemonStorage = 0x02028848`，标准 80 字节 box mon。
- **数据层 / server**：`index.js` 把 Radical Red 的 `data.js` 按 `dexID` 重映射成国家图鉴号；server 按 `romHack`/`gameCode` 自动路由到本适配器。
- **金手指（remote-edit）**：等级 / 努力值 / 个体值 / 性格 / 亲密度 / 持有物，均可改。

## 未完成 / 已知限制

1. **改特性未实现（目前空操作）**
   - Run & Bun 里 IV 字的 **bit 31 是 isEgg**（不是 RR/CFRU 的隐藏特性位），写它会把宝可梦变成蛋。
   - 现在 `applyEdit` 故意**保留 bit 30/31 原样**，只改 IV 的 bit 0–29。
   - abilityNum 推测在 **bit 30**（与 vanilla 对调），但未确认；隐藏特性（第 3 槽）存法未知。
   - 注意：网页点「改特性」时 server 仍返回成功、Lua 仍 ACK，但实际不改。要做对需先用受控测试确认 bit 30 的含义。

2. **捕获地点中文名缺失**
   - `index.js` 的 `MAPSEC_NAMES` 为空，Emerald 的 mapsec 表没建，所以 `metLocationNameZh` 为 null。

3. **图鉴数据是借用 Radical Red 的（按国家图鉴号重映射）**
   - 种族值 / 属性 / 特性反映的是 RR 的平衡，升级招式表也是 RR 的，持有物 ID 可能有偏差。
   - 名字和 sprite 是对的。以后换成 Run & Bun 专属数据时，只需改 `loadData()`。

4. **`PC_BOX_COUNT` 写死 14**（vanilla Emerald 默认）。若 Run & Bun 盒子更多，调大即可（多读的空格会被逐只校验过滤）。

5. **未移植 Radical Red 的定时即时存档（autosave）**。

6. **硬编码地址是针对 Run & Bun 1.07**（party `0x02023A98`、storage `0x02028848`）。换版本/存档若校验不过：队伍会自动扫描兜底；PC 可把 `party_export.lua` 顶部的 `PC_DISCOVERY` 设为 `true` 重新探测。
