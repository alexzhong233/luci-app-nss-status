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
	'.nss-vid .nss-vn{flex:none;font-size:11px;opacity:.55}';

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

/* 频率 → 频段名，和这台机器的三频对应。 */
function bandOf(freq) {
	if (!freq)
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
		return { ifindex: +k, freq: wifiMap[k].freq, ssid: wifiMap[k].ssid };
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

function fmtBytes(n) {
	var v = Number(n) || 0, i = 0;
	var unit = [ 'B', 'KB', 'MB', 'GB', 'TB' ];

	while (v >= 1024 && i < unit.length - 1) {
		v /= 1024;
		i++;
	}

	return (i === 0 ? String(v) : v.toFixed(2)) + ' ' + unit[i];
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

return view.extend({
	load: function() {
		return Promise.all([
			cat(BUS + '/state'),
			cat(DBG + '/wifili_rx'),
			cat(DBG + '/flows'),
			readLog(),
			cat('/sys/module/ath11k/parameters/nss_offload'),
			cat('/sys/module/nss_wifi_drv/parameters/wlan'),
			cat('/sys/module/nss_wifi_drv/parameters/firmware'),
			readWifi()
		]);
	},

	render: function(data) {
		var st = parseKv(data[0]);
		var offload = (data[4] || '').trim();
		var wlanParm = (data[5] || '').trim();
		var firmware = (data[6] || '').trim();
		var log = (data[3] || '').trim();
		var wifiMap = parseWifiMap(data[7] || '');

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
		var VCOLS = '2.8fr 1.2fr 1.4fr 1.2fr 1fr 1fr 1fr';
		var FCOLS = '2fr 1fr 1fr 1fr';

		var cell = function(content, align) {
			return E('div', {
				'class': 'nss-gc' + (align === 'center' ? ' c' : align === 'right' ? ' r' : '')
			}, Array.isArray(content) ? content : [ content ]);
		};

		var grow = function(cols, cells, head) {
			return E('div', {
				'class': 'nss-gr' + (head ? ' nss-gh' : ''),
				'style': 'grid-template-columns:' + cols
			}, cells);
		};

		/* ---- 接口收发 ---- */
		var vdevBody = E('div', {});

		function rowsVdev(raw, list) {
			while (vdevBody.firstChild)
				vdevBody.removeChild(vdevBody.firstChild);

			if (list.length === 0) {
				vdevBody.appendChild(grow(VCOLS, [
					E('div', { 'class': 'nss-gc e' }, [
						raw === '' ? '无数据' : '尚未上报 vdev'
					])
				]));
				return;
			}

			var paired = pairVdevs(list, wifiMap);

			list.forEach(function(v) {
				var w = paired[v.ifnum];
				var tag = w ? [ w.ssid, bandOf(w.freq) ].filter(Boolean).join(' · ') : '';
				var first;

				if (tag) {
					first = E('div', { 'class': 'nss-vid' }, [
						E('span', {
							'class': 'nss-vw',
							'title': tag + '（' + v.ifnum + '）'
						}, [ tag ]),
						E('span', { 'class': 'nss-vn' }, [ '（' + v.ifnum + '）' ])
					]);
				}
				else {
					/* 拿不到 SSID 就只给编号，不编一个名字上去 */
					first = E('code', {}, [ String(v.ifnum) ]);
				}

				vdevBody.appendChild(grow(VCOLS, [
					cell([ first ], 'center'),
					cell([ fmtNum(v.rx) ], 'right'),
					cell([ fmtBytes(v.bytes) ], 'right'),
					cell([ fmtNum(v.tx) ], 'right'),
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

		rowsVdev(data[1], parseVdevs(data[1]));
		rowsFlow(parseFlows(data[2]));

		/* 列宽由 fr 分配，表头行和数据行共用同一个 template，所以不可能错位。
		 * 外层 nss-gwrap 负责窄屏横向滚动。 */
		var vdevTable = E('div', { 'class': 'nss-gwrap' }, [
			E('div', { 'class': 'nss-grid' }, [
				grow(VCOLS, [
					cell('接口', 'center'), cell('收包', 'right'),
					cell('收字节', 'right'), cell('发包', 'right'),
					cell('例外', 'right'), cell('丢弃', 'right'),
					cell('Ring 满', 'right')
				], true),
				vdevBody
			])
		]);

		var flowTable = E('div', { 'class': 'nss-gwrap' }, [
			E('div', { 'class': 'nss-grid' }, [
				grow(FCOLS, [
					cell('节点'), cell('收包', 'right'),
					cell('发包', 'right'), cell('丢弃', 'right')
				], true),
				flowBody
			])
		]);

		/* ---- 两个面板 ---- */
		var statePane = E('div', {}, [
			E('div', { 'class': 'cbi-section' }, [
				E('h3', {}, [ '各接口收发统计' ]),
				vdevTable
			]),
			E('div', { 'class': 'cbi-section' }, [
				E('h3', {}, [ '流转发 ', flowSummary ]),
				flowTable
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
				cat(DBG + '/flows')
			]).then(function(d) {
				var fresh = parseKv(d[0]);

				while (cards.firstChild)
					cards.removeChild(cards.firstChild);

				buildCards(fresh, offload, wlanParm, firmware).forEach(function(c) {
					cards.appendChild(c);
				});

				setHead(fresh.ready === '1');

				rowsVdev(d[1], parseVdevs(d[1]));
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

	handleSaveApply: null,
	handleSave: null,
	handleReset: null
});
