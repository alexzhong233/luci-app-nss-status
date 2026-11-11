# luci-app-nss-status

Qualcomm IPQ 平台 **NSS Wi-Fi 卸载**状态页（LuCI / JS 版）。

读 `nss-wifi-drv` 的 debugfs 节点，把「Wi-Fi 到底有没有真的卸载到 NSS 硬件」摊开给人看——
不是看驱动版本号，是看计数器和 flow 表。

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

**接口收发**（3 秒刷新）：接口 / rx / bytes / tx / except / dropped / hw_ring_full，逐 vdev。

「接口」列第一行是 `wifili_rx` 报的 `vdev if <N>` 里的 N —— 它是 Linux 的 **ifindex**。
`/usr/libexec/nss-wifi-map` 用 `iw dev`（没有就用 `iwinfo` + sysfs）把 ifindex 翻成
**频段 · SSID**，显示在数字下面，长 SSID 省略、悬停看全名。对不上就只显示数字，
不按顺序猜 —— 贴错 SSID 比不贴更难排查。

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
| `/usr/libexec/nss-wifi-map` | 把 vdev 的 ifindex 翻成 SSID / 频率（`iw dev`，退回 `iwinfo`） |

## 依赖

- LuCI 21.02+ / master（JS 版视图，`'require view'` 模块）
- 内核侧：`nss-wifi-drv`（[VIKINGYFY/immortalwrt](https://github.com/VIKINGYFY/immortalwrt) `owrt` 分支所带的那套），
  或任何提供上述 debugfs 节点的 NSS Wi-Fi 卸载驱动。
- 运行时：`iw` 或 `iwinfo` 二者其一（拿 SSID 和频率）。两个都没有时接口列只显示编号。

**与 `qca-nss-drv` + ECM 那套是两条不同的技术栈。** 如果你的固件是 ECM 方案
（`/sys/kernel/debug/ecm/...`），用 [shadowvershh/luci-app-nssstatus](https://github.com/shadowvershh/luci-app-nssstatus)
更合适——那个读的是 ECM 的连接数/NSS CPU/n2h 吞吐，是 Lua 实现。

## 安装

**编译进固件**（推荐）：把本仓库放进构建树的 `package/`，或

```sh
# 在 feeds.conf.default 或构建脚本里
UPDATE_PACKAGE "luci-app-nss-status" "alexzhong233/luci-app-nss-status" "main"
```

**手动装 ipk**：装 `luci-app-nss-status`，然后 `/etc/init.d/rpcd restart`，刷新 LuCI。

页面位置：**状态 → NSS 卸载**（`/cgi-bin/luci/admin/status/nss`）。

## 换板子要改什么

DTS 里 NSS 的设备名是硬编码的，本包默认 `39000000.nss`（IPQ6000 / JDCloud AX6600 等）：

```js
var BUS = '/sys/bus/platform/devices/39000000.nss';
var DBG = '/sys/kernel/debug/39000000.nss';
```

换板子时改成新地址（`ls /sys/bus/platform/devices | grep nss` 查）。后续版本会做自动探测。

## 如何判断「NSS 真的在干活」

别只看驱动加载没加载。看这三处：

1. `数据平面 ready=1`、`Wi-Fi 卸载 已卸载`；
2. `接口收发` 里 rx/bytes 随流量增长；
3. `流转发` 的 `pushed` 在涨，说明新连接被下发了转发节点。

三者都不动，就说明流量在走 CPU 软转发，卸载没生效。

## License

MIT
