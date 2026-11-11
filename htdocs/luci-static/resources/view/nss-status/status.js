'use strict';
'require view';
'require fs';
'require poll';

/*
 * nss-wifi-drv 的状态页。
 *
 * 数据来源：
 *   /sys/bus/platform/devices/39000000.nss/state     一行 key=value 汇总
 *   /sys/kernel/debug/39000000.nss/wifili_rx         每个 vdev 的收发计数
 *   /sys/kernel/debug/39000000.nss/flows             已下发的流转发计数
 *   /sys/kernel/debug/39000000.nss/log               固件日志（可能为空）
 *   /sys/module/ath11k/parameters/nss_offload        Y/N
 *   /sys/module/nss_wifi_drv/parameters/{wlan,firmware}
 *
 * debugfs 目录名来自 DTS 里的 39000000.nss，换板子要跟着改。
 */

var BUS = '/sys/bus/platform/devices/39000000.nss';
var DBG = '/sys/kernel/debug/39000000.nss';
var WIFIMAP = '/usr/libexec/nss-wifi-map';
var REFRESH = 3;

/*
 * 两套 NSS 实现，debugfs 布局完全不同，页面得认两种：
 *
 *   nss-wifi-drv（VIKINGYFY/immortalwrt@owrt 那一套）
 *     /sys/kernel/debug/39000000.nss/{state,wifili_rx,flows,log}
 *     有无线口的逐 vdev 收发，有 peers / rings_ready 这类汇总；
 *     但**没有**核心负载（驱动不上报 cpu_load_ubi）。
 *
 *   qca-nss-drv + qca-nss-ecm（qosmio 系，LibWrt/25.12-nss 用的）
 *     /sys/kernel/debug/qca-nss-drv/stats/{cpu_load_ubi,n2h,ipv4,ipv6,pppoe,drv}
 *     /sys/kernel/debug/ecm/ecm_nss_{ipv4,ipv6}/<counter>
 *     有核心负载和 ECM 硬件流数，但拿不到每个无线口的收发。
 *
 * 两边的信息不可互换，所以哪个存在就走哪套渲染，不是"能不能读到"的问题。
 */
var QCA_STATS = '/sys/kernel/debug/qca-nss-drv/stats';
var QCA_ECM = '/sys/kernel/debug/ecm';

/* qca-nss-drv 的 stats 文件是 `name = value tag` 一行一项，tag 是核心号。 */
var QCA_MODULES = [
	{ id: 'n2h',   title: 'N2H 主机通道', rx: 'n2h_rx_pkts',       rxBytes: 'n2h_rx_byts',       tx: 'n2h_tx_pkts',       txBytes: 'n2h_tx_byts' },
	{ id: 'ipv4',  title: 'IPv4 加速',    rx: 'ipv4_rx_pkts',      rxBytes: 'ipv4_rx_byts',      tx: 'ipv4_tx_pkts',      txBytes: 'ipv4_tx_byts' },
	{ id: 'ipv6',  title: 'IPv6 加速',    rx: 'ipv6_rx_pkts',      rxBytes: 'ipv6_rx_byts',      tx: 'ipv6_tx_pkts',      txBytes: 'ipv6_tx_byts' },
	{ id: 'pppoe', title: 'PPPoE 加速',   rx: 'pppoe_rx_packets',  rxBytes: 'pppoe_rx_bytes',    tx: 'pppoe_tx_packets',  txBytes: 'pppoe_tx_bytes' }
];

/* ECM 的计数器同样是一文件一项，内容是纯数字。 */
var QCA_ECM_FAMILIES = [
	{ id: 'ipv4', title: 'IPv4', dir: QCA_ECM + '/ecm_nss_ipv4' },
	{ id: 'ipv6', title: 'IPv6', dir: QCA_ECM + '/ecm_nss_ipv6' }
];

var ECM_COUNTERS = [
	{ key: 'accelerated_count',     title: '加速流总数' },
	{ key: 'tcp_accelerated_count', title: 'TCP 流' },
	{ key: 'udp_accelerated_count', title: 'UDP 流' }
];

var STYLE = '' +
	'.nss-cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));' +
		'gap:.6rem;margin:.4rem 0 1rem}' +
	'.nss-card{position:relative;padding:.55rem .7rem .8rem;border-radius:8px;' +
		'border:1px solid rgba(128,128,128,.28);background:rgba(128,128,128,.06);' +
		'overflow:hidden}' +
	'.nss-card-h{display:flex;justify-content:space-between;align-items:center;' +
		'font-size:11px;opacity:.7;margin-bottom:.3rem}' +
	'.nss-card-i{width:9px;height:9px;border:1px solid currentColor;border-radius:2px;' +
		'opacity:.4;display:inline-block}' +
	'.nss-card-v{font-size:19px;font-weight:500;line-height:1.25;' +
		'white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
	'.nss-card-s{font-size:11px;opacity:.62;margin-top:.15rem;' +
		'white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
	'.nss-bar{position:absolute;left:0;right:0;bottom:0;height:2px;' +
		'background:rgba(128,128,128,.16)}' +
	'.nss-bar>i{display:block;height:100%}' +
	'.nss-head{display:flex;justify-content:space-between;align-items:baseline;' +
		'margin:.2rem 0 .1rem;font-size:12px}' +
	'.nss-tabs{display:flex;gap:.4rem;margin:.2rem 0 .8rem}' +
	'.nss-pre{max-height:32rem;overflow:auto;margin:0;padding:.6rem .7rem;' +
		'border-radius:6px;background:rgba(128,128,128,.1);font-size:12px;' +
		'line-height:1.5;white-space:pre-wrap;word-break:break-all}' +
	/*
	 * 不用 <table>。Argon / Aurora / 各种魔改主题对 table/th/td 的规则太多，
	 * 而且经常带 !important 和更高的选择器特异性：有的把 td 改成 display:block
	 * 做「窄屏卡片式」，有的给 th/td 不同的 padding/width，结果就是列宽由
	 * colgroup 定了、单元格内边距却各不相同，右对齐的数字挨个错开几个像素。
	 * 内联 style 和 .nss-tbl .c 这类选择器都压不住别人的 !important。
	 *
	 * 改用 CSS Grid：表头行和数据行共用同一个 grid-template-columns，列宽由
	 * 浏览器按 fr 分配，主题对 table 的那一套完全失效，也永远不会出现「表头
	 * 和数据两套宽度」的错位。
	 */
	'.nss-gwrap{width:100%;overflow-x:auto;-webkit-overflow-scrolling:touch}' +
	'.nss-grid{width:100%;min-width:460px;display:block;margin:0}' +
	'.nss-gr{display:grid!important;align-items:center;box-sizing:border-box;' +
		'padding:.42rem .5rem;border-bottom:1px solid rgba(128,128,128,.18);' +
		'font-size:13px;line-height:1.5;column-gap:0}' +
	'.nss-gh{font-weight:600;font-size:12px;opacity:.78;padding-top:.32rem;' +
		'padding-bottom:.32rem}' +
	'.nss-gc{display:block;min-width:0;white-space:nowrap;overflow:hidden;' +
		'text-overflow:ellipsis}' +
	'.nss-gc.c{text-align:center}' +
	'.nss-gc.r{text-align:right;font-variant-numeric:tabular-nums}' +
	'.nss-gc.e{grid-column:1/-1;opacity:.6}' +
	'.nss-grid code{padding:0;background:none;font-size:12px}' +
	/* 接口列一行：「SSID · 频段（编号）」；SSID 太长省略，编号固定在右边 */
	'.nss-vid{display:flex;align-items:baseline;justify-content:center;' +
		'gap:.3rem;min-width:0}' +
	'.nss-vid .nss-vw{min-width:0;overflow:hidden;text-overflow:ellipsis;' +
		'white-space:nowrap}' +
	'.nss-vid .nss-vn{flex:none;font-size:11px;opacity:.55}' +
	/* 表头带悬停说明：列名只写「收 / 发」，不看方向很容易理解反 */
	'.nss-tip{text-decoration:underline dotted rgba(128,128,128,.55);' +
		'text-underline-offset:3px;cursor:help}' +
	'.nss-note{font-size:12px;opacity:.62;margin:-.1rem 0 .55rem}' +
	/* 异常计数和流转发并排：都只有 4 列，分开各占一行太浪费竖向空间 */
	'.nss-duo{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);' +
		'gap:0 1.2rem;align-items:start}' +
	'@media (max-width:1100px){.nss-duo{grid-template-columns:minmax(0,1fr)}}' +
	/* 半宽时 460px 的最小宽度会撑出横向滚动条，这两张放小一点 */
	'.nss-grid-sm{min-width:300px}';

var GREEN = '#43a047', RED = '#e53935', BLUE = '#2196f3', DIM = 'rgba(128,128,128,.45)';

function cat(path) {
	return fs.exec('/bin/cat', [ path ]).then(function(r) {
		return (r && r.code === 0) ? String(r.stdout || '') : '';
	}).catch(function() { return ''; });
}

function sh(cmd) {
	return fs.exec('/bin/sh', [ '-c', cmd ]).then(function(r) {
		return (r && r.code === 0) ? String(r.stdout || '') : '';
	}).catch(function() { return ''; });
}

/* 交给 sh 解释，脚本有没有 x 位都能跑 —— 权限位在 Windows 上容易被 git 丢掉。 */
function readWifi() {
	return fs.exec('/bin/sh', [ WIFIMAP ]).then(function(r) {
		return (r && r.code === 0) ? String(r.stdout || '') : '';
	}).catch(function() { return ''; });
}

/*
 * wifili_rx 的 tx 行只有帧数（tx rcvd / enqueue / dropped / hw_ring_full），
 * 没有字节数，所以「发字节 / 发速度」只能从内核 netdev 统计里拿。
 */
function readWifiStats() {
	return fs.exec('/bin/sh', [ WIFIMAP, 'stats' ]).then(function(r) {
		return (r && r.code === 0) ? String(r.stdout || '') : '';
	}).catch(function() { return ''; });
}

/* 固件日志为空时退回内核里 nss 相关的行，否则这一栏永远是空白。 */
function readLog() {
	return cat(DBG + '/log').then(function(t) {
		t = (t || '').trim();
		if (t !== '')
			return t;
		return sh('dmesg 2>/dev/null | grep -i nss | tail -n 120');
	}).then(function(t) { return (t || '').trim(); });
}

function parseKv(text) {
	var out = {};
	var first = (text || '').trim().split('\n')[0] || '';
	first.trim().split(/\s+/).forEach(function(tok) {
		var i = tok.indexOf('=');
		if (i > 0)
			out[tok.slice(0, i)] = tok.slice(i + 1);
	});
	return out;
}

/*
 * wifili_rx 里的 "vdev if <N>" 是 Linux 的 ifindex。nss-wifi-map 把 ifindex
 * 翻成 SSID 和频率；拿不到就是空表，页面退回只显示数字，不瞎猜。
 */
function parseWifiMap(text) {
	var map = {};

	(text || '').split('\n').forEach(function(line) {
		var m = /^if (\d+) name (\S+) freq (\d+) ssid (.*)$/.exec(line.trim());

		if (m)
			map[+m[1]] = { ifname: m[2], freq: +m[3], ssid: m[4] };
	});

	return map;
}

/* nss-wifi-map stats 的输出 → { ifindex: { rx, tx } }。64 位计数器，不回绕。 */
function parseWifiStats(text) {
	var map = {};

	(text || '').split('\n').forEach(function(line) {
		var m = /^if (\d+) name (\S+) rx_bytes (\d+) tx_bytes (\d+)$/
			.exec(line.trim());

		if (m)
			map[+m[1]] = { rx: +m[3], tx: +m[4] };
	});

	return map;
}

/* 频率 → 频段名，和这台机器的三频对应。 */
function bandOf(freq) {	if (!freq)
		return '';
	if (freq < 3000)
		return '2.4G';
	if (freq < 5350)
		return '5.2G';
	if (freq < 5725)
		return '5.5G';
	return '5.8G';
}

/*
 * wifili 的 vdev 编号和 Linux 的 ifindex 是两套体系，内核没给映射表
 * （wifili_rx 里只有 if_num 和计数，没有 MAC、也没有 netdev 名）。
 * 但两边都是按创建顺序递增的：vdev 的 reports 严格递减（编号小的起得早），
 * ifindex 也递增。所以按位置配对。数量对不上就一张都不配 —— 宁可只显示
 * 编号，也不能贴个错的 SSID 上去。
 */
function pairVdevs(list, wifiMap) {
	var v = list.slice().sort(function(a, b) { return a.ifnum - b.ifnum; });
	var w = Object.keys(wifiMap || {}).map(function(k) {
		return {
			ifindex: +k,
			ifname: wifiMap[k].ifname,
			freq: wifiMap[k].freq,
			ssid: wifiMap[k].ssid
		};
	}).sort(function(a, b) { return a.ifindex - b.ifindex; });
	var out = {};

	if (v.length === 0 || v.length !== w.length)
		return out;

	v.forEach(function(item, i) { out[item.ifnum] = w[i]; });

	return out;
}

function parseVdevs(text) {
	var list = [], cur = null;

	(text || '').split('\n').forEach(function(line) {
		var t = line.trim();
		if (t === '')
			return;

		var m = t.match(/^vdev if (\d+) reports (\d+)$/);
		if (m) {
			cur = { ifnum: +m[1], reports: +m[2] };
			list.push(cur);
			return;
		}
		if (cur === null)
			return;

		var kv = {};
		t.replace(/([a-z_]+)\s+(\d+)/g, function(_, k, v) { kv[k] = +v; return ''; });

		if (t.indexOf('rx enqueue') === 0) {
			cur.rx = kv.enqueue || 0;
			cur.rx_fail = kv.fail || 0;
			cur.except = kv.except || 0;
			cur.bytes = kv.bytes || 0;
			cur.mcast = kv.mcast || 0;
		}
		else if (t.indexOf('rx decrypt_err') === 0) {
			cur.decrypt_err = kv.decrypt_err || 0;
			cur.mic_err = kv.mic_err || 0;
		}
		else if (t.indexOf('tx rcvd') === 0) {
			cur.tx = kv.rcvd || 0;
			cur.hw_ring_full = kv.hw_ring_full || 0;
			cur.dropped = kv.dropped || 0;
		}
	});

	return list;
}

function parseFlows(text) {
	var out = { bound: 0, pushed: 0, nodes: [] };

	(text || '').split('\n').forEach(function(line) {
		var t = line.trim();
		var m = t.match(/^bound (\d+) pushed (\d+)/);
		if (m) {
			out.bound = +m[1];
			out.pushed = +m[2];
			return;
		}

		m = t.match(/^node (\S+) rx (\d+) tx (\d+) drop (\S+)/);
		if (m)
			out.nodes.push({ name: m[1], rx: +m[2], tx: +m[3], drop: m[4] });
	});

	return out;
}

/*
 * qca-nss-drv 的 stats 文件格式：
 *
 *     ipv4_rx_pkts = 1234567 4
 *     ipv4_rx_byts = 987654321 4
 *     ...
 *
 * 行尾那个 tag 是 NSS 核心号。同一个计数器在每个核心上各有一行，第一行
 * （core 0）就是总量，后面的重复项不再累加 —— 这是驱动的约定，加错了会翻倍。
 * 所以只保留第一次出现的值。
 */
function parseQcaStats(text) {
	var out = {};

	(text || '').split('\n').forEach(function(line) {
		var m = line.match(/^\s*([A-Za-z0-9_\[\]-]+)\s*=\s*(\d+)\s+(\S+)\s*$/);

		if (m && !(m[1] in out))
			out[m[1]] = +m[2];
	});

	return out;
}

/*
 * cpu_load_ubi 的格式（驱动自己算的 1 秒平均）：
 *
 *     Core 0:
 *     Min  Avg  Max
 *      4%   5%  20%
 *     Core 1:
 *     ...
 *
 * 返回 [{ id, min, avg, max }]，拿不到就是空数组。
 */
function parseQcaLoad(text) {
	var cores = [], cur = null;

	(text || '').split('\n').forEach(function(line) {
		var m = line.match(/^\s*Core\s+(\d+)\s*:/i);

		if (m) {
			cur = { id: +m[1], min: null, avg: null, max: null };
			cores.push(cur);
			return;
		}

		if (!cur)
			return;

		m = line.match(/^\s*(\d+)%\s+(\d+)%\s+(\d+)%/);

		if (m) {
			cur.min = +m[1];
			cur.avg = +m[2];
			cur.max = +m[3];
		}
	});

	return cores;
}

/* ECM 的每个计数器是一个独立文件，内容就是裸数字。 */
function parseQcaNumber(text) {
	var v = parseInt((text || '').trim(), 10);

	return isNaN(v) ? null : v;
}

function fmtBytes(n) {
	var v = Number(n) || 0, i = 0;
	var unit = [ 'B', 'KB', 'MB', 'GB', 'TB' ];

	while (v >= 1024 && i < unit.length - 1) {
		v /= 1024;
		i++;
	}

	return (i === 0 ? String(v) : v.toFixed(2)) + ' ' + unit[i];
}

/* 速率固定两位小数，不管落在哪个单位 —— 否则小于 1 KB/s 时会露出
 * 84.19301164725458 这种原始浮点。 */
function fmtRate(n) {
	var v = Number(n) || 0, i = 0;
	var unit = [ 'B/s', 'KB/s', 'MB/s', 'GB/s', 'TB/s' ];

	while (v >= 1024 && i < unit.length - 1) {
		v /= 1024;
		i++;
	}

	return v.toFixed(2) + ' ' + unit[i];
}

function fmtNum(n) {
	return (Number(n) || 0).toLocaleString();
}

function wlanShort(v) {
	var n = parseInt(v, 10) || 0, parts = [];

	if (n & 1) parts.push('AHB');
	if (n & 2) parts.push('PCIe');

	return parts.length ? parts.join('+') : '无';
}

function dot(ok) {
	return E('span', { 'style': 'color:' + (ok ? GREEN : RED) + ';margin-right:.35rem' }, [ '●' ]);
}

function card(title, value, sub, pct, color) {
	return E('div', { 'class': 'nss-card' }, [
		E('div', { 'class': 'nss-card-h' }, [
			E('span', {}, [ title ]),
			E('span', { 'class': 'nss-card-i' })
		]),
		E('div', { 'class': 'nss-card-v' }, [ value ]),
		E('div', { 'class': 'nss-card-s' }, [ sub ]),
		E('div', { 'class': 'nss-bar' }, [
			E('i', { 'style': 'width:' + Math.max(0, Math.min(100, pct)) + '%;background:' + color })
		])
	]);
}

function buildCards(st, offload, wlanParm, firmware) {
	var ready = (st.ready === '1');
	var running = (st.running === '1');
	var started = Number(st.started || 0);
	var expected = Number(st.expected || 0);
	var peers = Number(st.peers || 0);
	var nvdev = Number(st.vdevs || 0);
	var unload = (offload === 'Y');
	var corePct = expected > 0 ? (started / expected) * 100 : 0;

	return [
		card('加速状态',
			ready ? '已就绪' : (running ? '未就绪' : '未启动'),
			'ready=' + (st.ready || '?') + ' running=' + (st.running || '?'),
			ready ? 100 : 100, ready ? GREEN : RED),

		card('Wi-Fi 卸载',
			unload ? '已卸载' : '未卸载',
			wlanShort(wlanParm || st.wlan) + ' · ' + (offload || '?'),
			unload ? 100 : 100, unload ? GREEN : DIM),

		card('NSS 核心',
			started + ' / ' + (expected || '?'),
			'rings_ready=' + (st.rings_ready || '?'),
			corePct, corePct >= 100 ? GREEN : RED),

		card('虚拟接口', nvdev + ' 个', 'vdev', 100, BLUE),

		card('硬件客户端', peers + ' 台', 'peers', 100, BLUE),

		card('固件线', firmware || st.firmware || '未知', 'firmware', 100, DIM)
	];
}

/*
 * 读一个 debugfs 文件，不存在返回 null。
 *
 * 不用 fs.read：LuCI 的 file ACL 是按路径白名单放行的，读 /sys 要额外写
 * ACL 条目，而且 rpcd 对符号链接会做二次校验（/var → /tmp 那个坑）。这里
 * 用 /bin/sh 跑一条 `test -e && cat` —— ACL 里本来就有 /bin/sh 的 exec 权限。
 *
 * 也不复用 cat()：cat() 失败返回空字符串，分不出「文件不存在」和「文件是
 * 空的」，而探测恰恰靠这个区分。
 */
function tryRead(path) {
	return fs.exec('/bin/sh', [ '-c', 'test -e ' + path + ' && cat ' + path ])
		.then(function(r) {
			if (!r || r.code !== 0)
				return null;

			return String(r.stdout || '');
		}).catch(function() { return null; });
}

function probe(path) {
	return tryRead(path).then(function(v) { return v != null; });
}

function loadWifili() {
	return Promise.all([
		cat(BUS + '/state'),
		cat(DBG + '/wifili_rx'),
		cat(DBG + '/flows'),
		readLog(),
		cat('/sys/module/ath11k/parameters/nss_offload'),
		cat('/sys/module/nss_wifi_drv/parameters/wlan'),
		cat('/sys/module/nss_wifi_drv/parameters/firmware'),
		readWifi(),
		readWifiStats()
	]).then(function(d) {
		return { mode: 'wifili', d: d };
	});
}

/*
 * qca 后端要读的文件数量是动态的（有些模块在这个平台上不存在，比如没有
 * PPPoE 的板子就没有 stats/pppoe），所以先拼一份 defs，统一变成 null，
 * 渲染时按 null 判断「这个模块不可用」而不是显示 0。
 */
function loadQca() {
	var defs = [ { k: 'load', p: QCA_STATS + '/cpu_load_ubi' } ];

	QCA_MODULES.forEach(function(mod) {
		defs.push({ k: 'mod:' + mod.id, p: QCA_STATS + '/' + mod.id });
	});

	QCA_ECM_FAMILIES.forEach(function(fam) {
		ECM_COUNTERS.forEach(function(c) {
			defs.push({ k: 'ecm:' + fam.id + ':' + c.key, p: fam.dir + '/' + c.key });
		});
	});

	return Promise.all(defs.map(function(def) {
		return tryRead(def.p);
	})).then(function(res) {
		var out = {};

		defs.forEach(function(def, i) {
			out[def.k] = res[i];
		});

		return { mode: 'qca', q: out };
	});
}

return view.extend({
	load: function() {
		return Promise.all([
			probe(DBG + '/state'),
			probe(QCA_STATS + '/cpu_load_ubi')
		]).then(function(p) {
			if (p[0])
				return loadWifili();
			if (p[1])
				return loadQca();
			return { mode: 'none' };
		});
	},

	render: function(payload) {
		if (payload.mode === 'qca')
			return this.renderQca(payload.q);

		if (payload.mode === 'none')
			return this.renderNoBackend();

		var d = payload.d;
		var st = parseKv(d[0]);
		var offload = (d[4] || '').trim();
		var wlanParm = (d[5] || '').trim();
		var firmware = (d[6] || '').trim();
		var log = (d[3] || '').trim();
		var wifiMap = parseWifiMap(d[7] || '');

		var cards = E('div', { 'class': 'nss-cards' },
			buildCards(st, offload, wlanParm, firmware));

		var headText = E('span', {}, [
			dot(st.ready === '1'),
			(st.ready === '1') ? '数据平面已就绪' : '数据平面未就绪'
		]);

		function setHead(ok) {
			while (headText.firstChild)
				headText.removeChild(headText.firstChild);

			headText.appendChild(dot(ok));
			headText.appendChild(document.createTextNode(
				ok ? '数据平面已就绪' : '数据平面未就绪'));
		}

		/*
		 * 只用单字母类名 c / r，和主题可能定义的 .center / .right 之类错开；
		 * 内联 text-align 保留，是主题样式表被拦掉时的兜底。真正管事的是
		 * STYLE 里 .nss-tbl .c / .r 那两条 !important。
		 */
		/*
		 * 表头和数据共用同一组列定义（fr 单位），这是「对齐」的唯一来源：
		 * 两行各建一个独立 grid，但 template 完全一致，所以永远不会偏。
		 */
		/* 7 列：接口 + 收包/收字节/收速度 + 发包/发字节/发速度，收发各给同样的宽度 */
		var VCOLS = '2.6fr 1.15fr 1.25fr 1.05fr 1.15fr 1.25fr 1.05fr';
		var DCOLS = '2.2fr .9fr .9fr .9fr';
		var FCOLS = '2fr 1fr 1fr 1fr';

		/* tip：鼠标悬停说明。列名只有「收 / 发」两字，不看方向容易理解反 */
		var cell = function(content, align, tip) {
			var a = {
				'class': 'nss-gc' + (align === 'center' ? ' c' : align === 'right' ? ' r' : '')
			};

			if (tip) {
				a['title'] = tip;
				a['class'] += ' nss-tip';
			}

			return E('div', a, Array.isArray(content) ? content : [ content ]);
		};

		var grow = function(cols, cells, head) {
			return E('div', {
				'class': 'nss-gr' + (head ? ' nss-gh' : ''),
				'style': 'grid-template-columns:' + cols
			}, cells);
		};

		/*
		 * 两张表分开：
		 *   表一 流量 —— 收（设备 → 路由器）和发（路由器 → 设备）各三列；
		 *   表二 异常 —— 例外 / 丢弃 / Ring 满，常态全是 0，跟流量混在一起
		 *   会白占宽度，也容易把「丢弃」看成速率那一列。
		 */
		var vdevBody = E('div', {});
		var errBody = E('div', {});

		function clearBody(el) {
			while (el.firstChild)
				el.removeChild(el.firstChild);
		}

		/*
		 * 速率用两次采样的差值算。字节数取的是内核 netdev 的 64 位计数，
		 * 不会回绕，所以相减不会出现负数。第一次渲染没有基准，返回 -1 显示成 —。
		 */
		var ratePrev = {}, txRatePrev = {};

		function rateOf(store, key, n) {
			var now = Date.now();
			var prev = store[key];

			store[key] = { n: n, t: now };

			if (!prev)
				return -1;

			var dt = (now - prev.t) / 1000;

			return dt > 0 ? (n - prev.n) / dt : -1;
		}

		/* 接口列：「SSID · 频段（编号）」；配不上就只给编号，不编名字 */
		function ifNode(v, w) {
			var tag = w ? [ w.ssid, bandOf(w.freq) ].filter(Boolean).join(' · ') : '';

			if (!tag)
				return E('code', {}, [ String(v.ifnum) ]);

			return E('div', { 'class': 'nss-vid' }, [
				E('span', { 'class': 'nss-vw', 'title': tag + '（' + v.ifnum + '）' }, [ tag ]),
				E('span', { 'class': 'nss-vn' }, [ '（' + v.ifnum + '）' ])
			]);
		}

		function rowsVdev(raw, list, stats) {
			clearBody(vdevBody);
			clearBody(errBody);

			if (list.length === 0) {
				var empty = raw === '' ? '无数据' : '尚未上报 vdev';

				vdevBody.appendChild(grow(VCOLS, [
					E('div', { 'class': 'nss-gc e' }, [ empty ])
				]));
				errBody.appendChild(grow(DCOLS, [
					E('div', { 'class': 'nss-gc e' }, [ empty ])
				]));
				return;
			}

			var paired = pairVdevs(list, wifiMap);

			list.forEach(function(v) {
				var w = paired[v.ifnum];
				var s = (w && stats[w.ifindex]) ? stats[w.ifindex] : null;

				/*
				 * 字节数一律用内核 netdev 的 64 位统计：NSS 的 rx bytes 是 32 位，
				 * 每 4 GiB 归零，算不出实际值；netdev 那个直接就是真实累计。
				 * 万一某块板子不计入 netdev（取不到或恒为 0），收字节退回 NSS
				 * 的原始计数，发字节没有可比的就显示 —。
				 */
				var rxb = (s && s.rx > 0) ? s.rx : (v.bytes || 0);
				var txb = (s && s.tx > 0) ? s.tx : null;
				var rate = rateOf(ratePrev, v.ifnum, rxb);
				var txRate = (txb !== null) ? rateOf(txRatePrev, v.ifnum, txb) : -1;

				vdevBody.appendChild(grow(VCOLS, [
					cell([ ifNode(v, w) ], 'center'),
					cell([ fmtNum(v.rx) ], 'right'),
					cell([ fmtBytes(rxb) ], 'right'),
					cell([ rate < 0 ? '—' : fmtRate(rate) ], 'right'),
					cell([ fmtNum(v.tx) ], 'right'),
					cell([ txb !== null ? fmtBytes(txb) : '—' ], 'right',
						txb !== null ? null : '取不到该接口的内核发送字节计数'),
					cell([ txRate < 0 ? '—' : fmtRate(txRate) ], 'right')
				]));

				errBody.appendChild(grow(DCOLS, [
					cell([ ifNode(v, w) ], 'center'),
					cell([ String(v.except || 0) ], 'right'),
					cell([ String(v.dropped || 0) ], 'right'),
					cell([ String(v.hw_ring_full || 0) ], 'right')
				]));
			});
		}

		/* ---- 流转发 ---- */
		var flowBody = E('div', {});
		var flowSummary = E('span', { 'style': 'font-size:12px;opacity:.65' });

		function rowsFlow(flows) {
			while (flowBody.firstChild)
				flowBody.removeChild(flowBody.firstChild);

			flowSummary.textContent = 'bound ' + flows.bound + ' / pushed ' + flows.pushed;

			if (flows.nodes.length === 0) {
				flowBody.appendChild(grow(FCOLS, [
					E('div', { 'class': 'nss-gc e' }, [ '尚未下发流转发节点' ])
				]));
				return;
			}

			flows.nodes.forEach(function(n) {
				flowBody.appendChild(grow(FCOLS, [
					cell([ E('code', {}, [ n.name ]) ]),
					cell([ fmtNum(n.rx) ], 'right'),
					cell([ fmtNum(n.tx) ], 'right'),
					cell([ n.drop ], 'right')
				]));
			});
		}

		rowsVdev(d[1], parseVdevs(d[1]), parseWifiStats(d[8] || ''));
		rowsFlow(parseFlows(d[2]));

		/* 列宽由 fr 分配，表头行和数据行共用同一个 template，所以不可能错位。
		 * 外层 nss-gwrap 负责窄屏横向滚动。表头带 title 的都加了虚线下划线，
		 * 让人知道可以把鼠标停上去。 */
		var vdevTable = E('div', { 'class': 'nss-gwrap' }, [
			E('div', { 'class': 'nss-grid' }, [
				grow(VCOLS, [
					cell('接口', 'center'),
					cell('收包', 'right',
						'设备 → 路由器：从无线上收到的帧数。本次开机以来累计，重启清零'),
					cell('收字节', 'right',
						'设备 → 路由器：本次开机以来累计收到的字节（64 位，不会回绕）。' +
						'客户端主要在下载时，上行基本只有 TCP ACK，每包只有几十字节，' +
						'所以这一列比「发字节」小是正常的'),
					cell('收速度', 'right',
						'设备 → 路由器：按两次采样差值算出的实时速率'),
					cell('发包', 'right',
						'路由器 → 设备：发往无线的帧数。本次开机以来累计，重启清零'),
					cell('发字节', 'right',
						'路由器 → 设备：本次开机以来累计发送字节（64 位，不会回绕）。' +
						'客户端下载时这一列远大于「收字节」'),
					cell('发速度', 'right',
						'路由器 → 设备：按两次采样差值算出的实时速率')
				], true),
				vdevBody
			])
		]);

		var errTable = E('div', { 'class': 'nss-gwrap' }, [
			E('div', { 'class': 'nss-grid nss-grid-sm' }, [
				grow(DCOLS, [
					cell('接口', 'center'),
					cell('例外', 'right', 'rx except：NSS 处理不了、退回 CPU 处理的帧'),
					cell('丢弃', 'right', 'tx dropped：发送路径上被丢掉的帧'),
					cell('Ring 满', 'right', 'tx hw_ring_full：发送 ring 没有空槽位，装不下的帧')
				], true),
				errBody
			])
		]);

		var flowTable = E('div', { 'class': 'nss-gwrap' }, [
			E('div', { 'class': 'nss-grid nss-grid-sm' }, [
				grow(FCOLS, [
					cell('节点'),
					cell('收包', 'right', '该硬件流节点收到的帧数（累计）'),
					cell('发包', 'right', '该硬件流节点发出的帧数（累计）'),
					cell('丢弃', 'right', '该硬件流节点丢掉的帧数')
				], true),
				flowBody
			])
		]);

		/* ---- 两个面板 ---- */
		var statePane = E('div', {}, [
			E('div', { 'class': 'cbi-section' }, [
				E('h3', {}, [ '各接口收发统计' ]),
				E('div', { 'class': 'nss-note' }, [
					'收 = 设备 → 路由器（上行），发 = 路由器 → 设备（下行）。' +
					'所有计数都是本次开机以来累计，重启清零。'
				]),
				vdevTable
			]),
			/* 异常和转发各 4 列，并排一行；窄屏（<1100px）自动落回上下排列 */
			E('div', { 'class': 'nss-duo' }, [
				E('div', { 'class': 'cbi-section' }, [
					E('h3', {}, [ '硬件异常计数' ]),
					E('div', { 'class': 'nss-note' }, [
						'累计值，重启才清零。三个都是 0 才正常。'
					]),
					errTable
				]),
				E('div', { 'class': 'cbi-section' }, [
					E('h3', {}, [ '流转发 ', flowSummary ]),
					E('div', { 'class': 'nss-note' }, [
						'bound = 当前生效的流数，pushed = 累计推给硬件的包数。' +
						'pushed 不涨说明没走硬件。'
					]),
					flowTable
				])
			])
		]);

		var logPane = E('div', { 'style': 'display:none' }, [
			E('pre', { 'class': 'nss-pre' }, [ log !== '' ? log : '无输出' ])
		]);

		/* ---- 标签切换 ---- */
		var tabState = E('button', { 'class': 'btn cbi-button cbi-button-action' }, [ '状态' ]);
		var tabLog = E('button', { 'class': 'btn cbi-button' }, [ '日志' ]);

		function show(which) {
			var isState = (which === 'state');

			statePane.style.display = isState ? '' : 'none';
			logPane.style.display = isState ? 'none' : '';

			tabState.className = 'btn cbi-button' + (isState ? ' cbi-button-action' : '');
			tabLog.className = 'btn cbi-button' + (isState ? '' : ' cbi-button-action');
		}

		tabState.addEventListener('click', function(ev) {
			ev.preventDefault();
			show('state');
		});

		tabLog.addEventListener('click', function(ev) {
			ev.preventDefault();
			show('log');
		});

		/* ---- 每 3 秒刷新计数 ---- */
		poll.add(function() {
			if (statePane.style.display === 'none')
				return Promise.resolve();

			return Promise.all([
				cat(BUS + '/state'),
				cat(DBG + '/wifili_rx'),
				cat(DBG + '/flows'),
				readWifiStats()
			]).then(function(d) {
				var fresh = parseKv(d[0]);

				while (cards.firstChild)
					cards.removeChild(cards.firstChild);

				buildCards(fresh, offload, wlanParm, firmware).forEach(function(c) {
					cards.appendChild(c);
				});

				setHead(fresh.ready === '1');

				rowsVdev(d[1], parseVdevs(d[1]), parseWifiStats(d[3] || ''));
				rowsFlow(parseFlows(d[2]));
			});
		}, REFRESH);

		return E('div', { 'class': 'cbi-map' }, [
			E('style', {}, [ STYLE ]),
			E('h2', {}, [ 'NSS 卸载' ]),
			E('div', { 'class': 'nss-head' }, [
				headText,
				E('span', { 'style': 'opacity:.6' },
					[ '实时 · 每 ' + REFRESH + ' 秒' ])
			]),
			cards,
			E('div', { 'class': 'nss-tabs' }, [ tabState, tabLog ]),
			statePane,
			logPane
		]);
	},

	/*
	 * qca-nss-drv + qca-nss-ecm 那套的渲染。
	 *
	 * 信息结构和 wifili 完全不同，所以另起一套，不复用上面的表：
	 *   · NSS 核心负载 —— cpu_load_ubi，驱动自己算的 1 秒平均
	 *   · 各模块累计收发 + 速率 —— stats/{n2h,ipv4,ipv6,pppoe}
	 *   · ECM 硬件加速流数 —— ecm/ecm_nss_{ipv4,ipv6}/<counter>
	 *
	 * 拿不到的项一律显示 —，不拿 0 冒充。这个平台没跑 PPPoE 的话，
	 * stats/pppoe 根本不存在，显示 0 会让人以为「一次都没走过」。
	 */
	renderQca: function(q) {
		var CCOLS = '1.1fr 1.2fr 1.3fr 1.2fr 1.3fr';
		var ECOLS = '1fr 1.2fr 1fr 1fr';

		var cell = function(content, align, tip) {
			var a = {
				'class': 'nss-gc' + (align === 'center' ? ' c' : align === 'right' ? ' r' : '')
			};

			if (tip) {
				a['title'] = tip;
				a['class'] += ' nss-tip';
			}

			return E('div', a, Array.isArray(content) ? content : [ content ]);
		};

		var grow = function(cols, cells, head) {
			return E('div', {
				'class': 'nss-gr' + (head ? ' nss-gh' : ''),
				'style': 'grid-template-columns:' + cols
			}, cells);
		};

		var cards = E('div', { 'class': 'nss-cards' });
		var modBody = E('div', {});
		var ecmBody = E('div', {});

		/* 上一轮的累计值，用来算速率。第一次没有基准，速率显示 —。 */
		var prev = null;

		/* 累计值 + 下面一行小字写速率，一列里放两个数，省宽度 */
		var numRate = function(total, rate) {
			if (total == null)
				return [ '—' ];

			return [
				fmtNum(total),
				E('div', { 'style': 'font-size:11px;opacity:.6;line-height:1.3' }, [
					rate == null ? '—' : rate
				])
			];
		};

		function rateOf(now, before, dt, fmt) {
			if (now == null || before == null || !(dt > 0))
				return null;

			var diff = now - before;

			/* 计数器被重置（驱动重载 / 回绕）时不要显示负数 */
			return (diff >= 0) ? fmt(diff / dt) : null;
		}

		function fill(data) {
			var cores = parseQcaLoad(data['load']);
			var now = Date.now();
			var dt = prev ? (now - prev.t) / 1000 : 0;

			/* ---- 卡片 ---- */
			var avg = cores.length
				? Math.round(cores.reduce(function(s, c) { return s + (c.avg || 0); }, 0) / cores.length)
				: null;

			var acc = {}, hasAcc = false;

			QCA_ECM_FAMILIES.forEach(function(fam) {
				var v = parseQcaNumber(data['ecm:' + fam.id + ':accelerated_count']);

				acc[fam.id] = v;

				if (v != null)
					hasAcc = true;
			});

			var totalAcc = hasAcc ? ((acc.ipv4 || 0) + (acc.ipv6 || 0)) : null;
			var ipv4 = parseQcaStats(data['mod:ipv4']);
			var n2h = parseQcaStats(data['mod:n2h']);

			while (cards.firstChild)
				cards.removeChild(cards.firstChild);

			[
				card('NSS 核心',
					cores.length ? cores.length + ' 个' : '—',
					'qca-nss-drv',
					cores.length ? 100 : 0,
					cores.length ? GREEN : RED),

				card('平均负载',
					avg == null ? '—' : avg + '%',
					cores.length ? '1 秒平均 · 各核平均' : '驱动未上报',
					avg == null ? 0 : avg,
					avg == null ? DIM : (avg >= 80 ? RED : (avg >= 40 ? BLUE : GREEN))),

				card('硬件加速流',
					totalAcc == null ? '—' : fmtNum(totalAcc),
					'ECM IPv4 + IPv6',
					totalAcc ? 100 : 0,
					totalAcc == null ? DIM : BLUE),

				card('IPv4 加速包',
					ipv4.ipv4_rx_pkts == null ? '—' : fmtNum(ipv4.ipv4_rx_pkts),
					'累计接收',
					ipv4.ipv4_rx_pkts ? 100 : 0,
					ipv4.ipv4_rx_pkts == null ? DIM : BLUE),

				card('N2H 通道包',
					n2h.n2h_rx_pkts == null ? '—' : fmtNum(n2h.n2h_rx_pkts),
					'累计接收 · 主机↔NSS',
					n2h.n2h_rx_pkts ? 100 : 0,
					n2h.n2h_rx_pkts == null ? DIM : BLUE)
			].forEach(function(c) {
				cards.appendChild(c);
			});

			/* ---- 模块吞吐 ---- */
			while (modBody.firstChild)
				modBody.removeChild(modBody.firstChild);

			var next = { t: now, mods: {} };

			QCA_MODULES.forEach(function(mod) {
				var st = parseQcaStats(data['mod:' + mod.id]);
				var avail = (data['mod:' + mod.id] != null);

				var rx = avail ? (st[mod.rx] != null ? st[mod.rx] : null) : null;
				var rxB = avail ? (st[mod.rxBytes] != null ? st[mod.rxBytes] : null) : null;
				var tx = avail ? (st[mod.tx] != null ? st[mod.tx] : null) : null;
				var txB = avail ? (st[mod.txBytes] != null ? st[mod.txBytes] : null) : null;

				var p = prev && prev.mods[mod.id];

				next.mods[mod.id] = { rx: rx, rxB: rxB, tx: tx, txB: txB };

				modBody.appendChild(grow(CCOLS, [
					cell([ mod.title ], null, avail ? null : '这个模块在当前平台上不存在'),
					cell(numRate(rx, rateOf(rx, p && p.rx, dt, function(v) { return fmtNum(Math.round(v)) + ' pkt/s'; })), 'right',
						'从 NSS 收到、交给主机的包（累计 / 实时速率）'),
					cell(numRate(rxB, rateOf(rxB, p && p.rxB, dt, fmtRate)), 'right',
						'对应字节数（累计 / 实时速率）'),
					cell(numRate(tx, rateOf(tx, p && p.tx, dt, function(v) { return fmtNum(Math.round(v)) + ' pkt/s'; })), 'right',
						'主机交给 NSS 发出去的包（累计 / 实时速率）'),
					cell(numRate(txB, rateOf(txB, p && p.txB, dt, fmtRate)), 'right',
						'对应字节数（累计 / 实时速率）')
				]));
			});

			/* ---- ECM ---- */
			while (ecmBody.firstChild)
				ecmBody.removeChild(ecmBody.firstChild);

			QCA_ECM_FAMILIES.forEach(function(fam) {
				var vals = ECM_COUNTERS.map(function(c) {
					return parseQcaNumber(data['ecm:' + fam.id + ':' + c.key]);
				});

				var none = vals.every(function(v) { return v == null; });

				ecmBody.appendChild(grow(ECOLS, [
					cell([ fam.title ], null, none ? 'ECM 没有这个协议族的目录' : null),
					cell([ vals[0] == null ? '—' : fmtNum(vals[0]) ], 'right',
						'当前被 NSS 硬件接管的连接数'),
					cell([ vals[1] == null ? '—' : fmtNum(vals[1]) ], 'right', '其中 TCP'),
					cell([ vals[2] == null ? '—' : fmtNum(vals[2]) ], 'right', '其中 UDP')
				]));
			});

			prev = next;
		}

		fill(q);

		var coreTable = E('div', { 'class': 'nss-gwrap' }, [
			E('div', { 'class': 'nss-grid nss-grid-sm' }, [
				grow(CCOLS, [
					cell('模块'),
					cell('收包', 'right'), cell('收字节', 'right'),
					cell('发包', 'right'), cell('发字节', 'right')
				], true),
				modBody
			])
		]);

		var ecmTable = E('div', { 'class': 'nss-gwrap' }, [
			E('div', { 'class': 'nss-grid nss-grid-sm' }, [
				grow(ECOLS, [
					cell('协议'),
					cell('加速流总数', 'right'),
					cell('TCP 流', 'right'),
					cell('UDP 流', 'right')
				], true),
				ecmBody
			])
		]);

		poll.add(function() {
			return loadQca().then(function(r) {
				fill(r.q);
			});
		}, REFRESH);

		return E('div', { 'class': 'cbi-map' }, [
			E('style', {}, [ STYLE ]),
			E('h2', {}, [ 'NSS 加速（qca-nss-drv）' ]),
			E('div', { 'class': 'nss-head' }, [
				E('span', {}, [
					dot(true),
					'数据来自 ',
					E('code', {}, [ QCA_STATS ])
				]),
				E('span', { 'style': 'opacity:.6' },
					[ '实时 · 每 ' + REFRESH + ' 秒' ])
			]),
			E('div', { 'class': 'nss-note' }, [
				'这套上游用的是 qca-nss-drv + qca-nss-ecm，和 nss-wifi-drv 的 ' +
				'39000000.nss 布局不同，所以看不到每个无线口的收发明细 —— ' +
				'那部分只有 wifili 那套才提供。'
			]),
			cards,
			E('div', { 'class': 'cbi-section' }, [
				E('h3', {}, [ 'NSS 模块吞吐' ]),
				E('div', { 'class': 'nss-note' }, [
					'上行是「NSS → 主机」，下行是「主机 → NSS」。' +
					'每格上面是本次开机以来的累计值，下面是实时速率。'
				]),
				coreTable
			]),
			E('div', { 'class': 'cbi-section' }, [
				E('h3', {}, [ 'ECM 硬件加速流' ]),
				E('div', { 'class': 'nss-note' }, [
					'当前被 NSS 硬件接管的连接数。为 0 说明流量都在 CPU 上走。'
				]),
				ecmTable
			])
		]);
	},

	/* 两套 debugfs 都不在：说明这台机器没用 NSS，或者驱动没加载 */
	renderNoBackend: function() {
		return E('div', { 'class': 'cbi-map' }, [
			E('style', {}, [ STYLE ]),
			E('h2', {}, [ 'NSS 卸载' ]),
			E('div', { 'class': 'nss-note' }, [
				dot(false),
				'没有检测到 NSS 驱动。'
			]),
			E('pre', { 'class': 'nss-pre' }, [
				'检查过这两个后端，都不存在：\n\n' +
				'  ' + DBG + '/state          （nss-wifi-drv，VIKINGYFY/owrt 那套）\n' +
				'  ' + QCA_STATS + '/cpu_load_ubi （qca-nss-drv，LibWrt/qosmio 那套）\n\n' +
				'可能的原因：\n' +
				'  · 这版固件没编进 NSS 驱动；\n' +
				'  · 驱动编进去了但没加载（nss-firmware 缺失、DTS 不匹配）；\n' +
				'  · 机器不是 IPQ60xx / IPQ807x。\n\n' +
				'排查：\n' +
				'  dmesg | grep -i nss | tail -20\n' +
				'  ls /sys/kernel/debug/ | grep -iE "nss|ecm"\n' +
				'  lsmod | grep -i nss'
			])
		]);
	},

	handleSaveApply: null,
	handleSave: null,
	handleReset: null
});
