# SPDX-License-Identifier: MIT
#
# luci-app-nss-status - NSS Wi-Fi offload status page for Qualcomm IPQ boards

include $(TOPDIR)/rules.mk

PKG_NAME:=luci-app-nss-status
PKG_VERSION:=1.0.0
PKG_RELEASE:=1
PKG_LICENSE:=MIT
PKG_MAINTAINER:=Alex Zhong <alexzhong233@users.noreply.github.com>

LUCI_TITLE:=NSS Wi-Fi offload status
LUCI_DESCRIPTION:=LuCI page for nss-wifi-drv: offload state, per-vdev counters, \
	offloaded flow table and firmware log (IPQ60xx / IPQ807x with NSS Wi-Fi offload).
LUCI_PKGARCH:=all

# 页面读的是 nss-wifi-drv 的 debugfs 节点。驱动不在时页面显示"未启用"而不是报错，
# 所以这里不硬依赖 nss-wifi-drv（各家 feeds 的包名不一致），只依赖 LuCI 基础。
# 需要强制带驱动时，把下面这行换成本地实际的驱动包名，例如 +nss-firmware。
LUCI_DEPENDS:=+luci-base

include $(TOPDIR)/feeds/luci/luci.mk

# call BuildPackage - OpenWrt buildroot signature
