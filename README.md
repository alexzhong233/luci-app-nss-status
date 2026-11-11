# luci-app-nss-status

Qualcomm IPQ 平台 **NSS 硬件加速**状态页（LuCI / JS 版）。

一套页面认两种 NSS 实现，自动判断该读哪套 debugfs：

| 后端 | 驱动 | debugfs | 能看到 |
|---|---|---|---|
| `nss-wifi-drv` | [VIKINGYFY/immortalwrt](https://github.com/VIKINGYFY/immortalwrt) `owrt` | `/sys/kernel/debug/39000000.nss/` | 每个无线口的收发、vdev、peers、流转发 |
| `qca-nss-drv` + `qca-nss-ecm` | [qosmio 系 nss-packages](https://github.com/qosmio/nss-packages) | `/sys/kernel/debug/qca-nss-drv/stats/`、`/ecm/` | NSS 核心负载、模块吞吐、ECM 硬件流数 |

判断依据是「哪个标志文件存在」：`39000000.nss/state` 在就是前者，
`qca-nss-drv/stats/cpu_load_ubi` 在就是后者。两个都不在，页面直接告诉你去查什么，
而不是显示一堆空框。

另外会在**「状态 → 概览」**插一个 NSS 区块（不用点进来就能看到是否在工作）。

![license](https://img.shields.io/badge/license-MIT-blue.svg)

## 功能

**概览卡片**

| 卡片 | 内容 |
|---|---|
| 数据平面 | `ready` / `running`（读 `state` 汇总行） |
| Wi-Fi 卸载 | 已卸载 / 未卸载（`ath11k/nss_offload` + `nss_wifi_drv/wlan` 参数） |
| NSS 核心 | 已启动核数 / 期望核数 + `rings_ready` |
| 虚拟接口 | vdev 数量 |
| 硬件客户端 | 上报的 peers 数 |
| 固件线 | `nss_wifi_drv/firmware` 参数值 |

**各接口收发统计**（3 秒刷新，逐 vdev）—— 收发各三列，方向以路由器为准：

| 列 | 帧数来源 | 字节/速率来源 | 方向 |
|---|---|---|---|
| 收包 / 收字节 / 收速度 | `rx enqueue` | netdev `rx_bytes` | **设备 → 路由器**（上行） |
| 发包 / 发字节 / 发速度 | `tx rcvd` | netdev `tx_bytes` | **路由器 → 设备**（下行） |

表头带虚线下划线的列名可以鼠标停上去看说明。

**字节数一律取内核 netdev 的 64 位统计**（`/sys/class/net/<ifname>/statistics/`），
直接就是实际累计值，不需要补偿。`wifili_rx` 那边不能用：它的 `rx bytes` 是 32 位，
每 4 GiB 归零；`tx` 行只有帧数、根本没有字节字段。速率按两次采样差值算，统一两位
小数。取不到（接口没配上、或该板子不计入 netdev）就显示 `—`，不拿 0 冒充。

**硬件异常计数**（同一次轮询，单独一张表）：`except` / `dropped` / `hw_ring_full`，
累计值、重启清零，三个都是 0 才正常。这张表和「流转发」并排一行（窄屏 <1100px
自动落回上下排列）。

「接口」列显示成 `niubiAlexGaming · 5.2G（33）`，括号里就是 `wifili_rx` 报的
`vdev if <N>` 里的 N。它是 **NSS 自己的 vdev 编号，不是 Linux 的 ifindex** ——
这台机器上 vdev 是 31/32/33，而 ifindex 是 10/11/12。debugfs 里既没有 MAC 也没有
netdev 名，所以拿不到直接映射。

`/usr/libexec/nss-wifi-map` 用 `iw dev`（没有就用 `iwinfo` + sysfs）列出每个 netdev 的
ifindex / 频率 / SSID；`nss-wifi-map stats` 另行回传每个 netdev 的 `tx_bytes`。
页面把两边**按创建顺序配对**：vdev 的 `reports` 计数严格递减（编号小的先创建），
ifindex 也递增，于是位置一一对应。**数量对不上就一张都不配**，只显示编号 ——
贴错 SSID 比不贴更难排查。

配对是推断出来的。验证办法：让一台只连 5.2G 的设备跑流量，看是不是编号最大的那个
vdev 增长最快。对不上就把 `iw dev | grep -E "Interface|ssid|channel"` 的输出发出来。

想先确认映射关系，不用重编固件，路由器上直接对比两边：

```sh
iw dev | grep -E "Interface|ifindex|ssid"
grep "vdev if" /sys/kernel/debug/39000000.nss/wifili_rx
```

**流转发**：`bound` / `pushed` 汇总 + 每个 flow 节点的转发计数。

**固件日志**：`debugfs/.../log` 原文，可滚动。

## 数据来源

| 路径 | 用途 |
|---|---|
| `/sys/bus/platform/devices/39000000.nss/state` | 一行 key=value 汇总（ready/running/cores/rings_ready/vdev…） |
| `/sys/kernel/debug/39000000.nss/wifili_rx` | 每个 vdev 的收发计数 |
| `/sys/kernel/debug/39000000.nss/flows` | 已下发的流转发计数 |
| `/sys/kernel/debug/39000000.nss/log` | 固件日志 |
| `/sys/module/ath11k/parameters/nss_offload` | Y/N |
| `/sys/module/nss_wifi_drv/parameters/wlan`、`/firmware` | 绑定网卡 / 固件线 |
| `/sys/class/net/<ifname>/statistics/{rx,tx}_bytes` | 64 位字节累计（收发字节/速率的来源） |
| `/usr/libexec/nss-wifi-map` | 把 vdev 的 ifindex 翻成 SSID / 频率（`iw dev`，退回 `iwinfo`）；`stats` 子命令回传各 netdev 的 `rx_bytes`/`tx_bytes` |

qca-nss-drv 后端读的是这些（前一组只在对应后端存在时才读）：

| 路径 | 用途 |
|---|---|
| `/sys/kernel/debug/qca-nss-drv/stats/cpu_load_ubi` | 各 NSS 核心 1 秒平均负载（也是后端标志） |
| `/sys/kernel/debug/qca-nss-drv/stats/{n2h,ipv4,ipv6,pppoe}` | 模块收发计数，`name = value tag` |
| `/sys/kernel/debug/ecm/ecm_nss_{ipv4,ipv6}/<counter>` | ECM 硬件加速流数（一文件一项） |

## qca-nss-drv + ECM 模式

识别到 `/sys/kernel/debug/qca-nss-drv/stats/cpu_load_ubi` 时走这套：

**概览卡片**：NSS 核心数、平均负载、ECM 硬件加速流总数、IPv4 加速包、N2H 通道包

**NSS 模块吞吐**：`stats/{n2h,ipv4,ipv6,pppoe}` 各模块的收发包/字节，累计值 + 实时速率
（上下两行同格显示）

**ECM 硬件加速流**：`ecm/ecm_nss_{ipv4,ipv6}/` 下 `accelerated_count` /
`tcp_accelerated_count` / `udp_accelerated_count`

几个实现细节：

- `stats/*` 的行格式是 `name = value tag`，**tag 是 NSS 核心号**，同一个计数器每个核
  各有一行。只取第一次出现的值，后面的不累加 —— 驱动约定第一行就是总量，累加会翻倍。
- 模块文件不存在（比如没跑 PPPoE 就没有 `stats/pppoe`）时整行显示 `—`，不显示 0。
  显示 0 会让人以为「一次都没走过」，两件事分不清。
- 计数器被重置（驱动重载）时速率跳过那一轮，不显示负数。

## 依赖

- LuCI 21.02+ / master（JS 版视图，`'require view'` 模块）
- 内核侧二选一：
  - `nss-wifi-drv`（[VIKINGYFY/immortalwrt](https://github.com/VIKINGYFY/immortalwrt) `owrt` 分支）
  - `qca-nss-drv` + `qca-nss-ecm`（[qosmio 系 nss-packages](https://github.com/qosmio/nss-packages)，
    例如 [LiBwrt/LibWrt](https://github.com/LiBwrt/LibWrt) `25.12-nss`）
- 运行时：`iw` 或 `iwinfo` 二者其一（拿 SSID 和频率）。两个都没有时接口列只显示编号。
  这个只有 wifili 后端用得到。

两套都装也没关系：各读各的目录，互不干扰。

## 安装

**编译进固件**（推荐）：把本仓库放进构建树的 `package/`，或

```sh
# 在 feeds.conf.default 或构建脚本里
UPDATE_PACKAGE "luci-app-nss-status" "alexzhong233/luci-app-nss-status" "main"
```

**手动装 ipk**：装 `luci-app-nss-status`，然后 `/etc/init.d/rpcd restart`，刷新 LuCI。

页面位置：**状态 → NSS 加速**（`/cgi-bin/luci/admin/status/nss`），
另外「状态 → 概览」里会多一个 NSS 区块。

## 换板子要改什么

**只有 wifili 后端需要改**，`qca-nss-drv` 的路径是通用的（各平台一致）。

DTS 里 NSS 的设备名是硬编码的，本包默认 `39000000.nss`（IPQ6000 / JDCloud AX6600 等）：

```js
var BUS = '/sys/bus/platform/devices/39000000.nss';
var DBG = '/sys/kernel/debug/39000000.nss';
```

换板子时改成新地址（`ls /sys/bus/platform/devices | grep nss` 查）。
改不到也不会显示错的东西 —— 探测失败就走 `qca-nss-drv` 那条，两个都没有就显示排查提示。

## 如何判断「NSS 真的在干活」

**nss-wifi-drv 后端**，别只看驱动加载没加载，看这三处：

1. `数据平面 ready=1`、`Wi-Fi 卸载 已卸载`；
2. `接口收发` 里 rx/bytes 随流量增长；
3. `流转发` 的 `pushed` 在涨，说明新连接被下发了转发节点。

三者都不动，就说明流量在走 CPU 软转发，卸载没生效。

**qca-nss-drv 后端**：

1. `NSS Core` 卡片有核数、负载不是 `—`（说明驱动已经在报状态）；
2. 压流量时 `NSS 模块吞吐` 的 IPv4 收包速率在涨；
3. `ECM 硬件加速流` 的总数不为 0 —— 为 0 说明连接全在 CPU 上走 conntrack，没交给硬件。

第 3 条最关键：ECM 流数为 0 时，即使驱动、固件都正常，也等于没加速。

## License

MIT
