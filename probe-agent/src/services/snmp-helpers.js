// ============================================================
// C-Flex FMS — SNMP helpers (TASK 5)
// SNMPv3 session creation + APC PowerNet OID branch
// ============================================================
const snmp = require('net-snmp');

// 표준 UPS-MIB (RFC 1628) — 모든 SNMP-호환 UPS 기본
const OID_UPS_MIB = {
  identManufacturer: '1.3.6.1.2.1.33.1.1.1.0',
  identModel:        '1.3.6.1.2.1.33.1.1.2.0',
  identFirmware:     '1.3.6.1.2.1.33.1.1.3.0',
  batteryStatus:     '1.3.6.1.2.1.33.1.2.1.0',
  batteryRuntime:    '1.3.6.1.2.1.33.1.2.3.0',
  batteryCharge:     '1.3.6.1.2.1.33.1.2.4.0',
  batteryVoltage:    '1.3.6.1.2.1.33.1.2.5.0',
  batteryTemp:       '1.3.6.1.2.1.33.1.2.7.0',
  inputVoltage:      '1.3.6.1.2.1.33.1.3.3.1.3.1',
  outputSource:      '1.3.6.1.2.1.33.1.4.1.0',
  outputVoltage:     '1.3.6.1.2.1.33.1.4.4.1.2.1',
  outputLoad:        '1.3.6.1.2.1.33.1.4.4.1.5.1',
};

// APC PowerNet-MIB (vendor=APC) — 정확한 측정값 + 부가 정보
const OID_APC_POWERNET = {
  identManufacturer: '1.3.6.1.2.1.33.1.1.1.0',  // upsIdent (표준 폴백)
  identModel:        '1.3.6.1.4.1.318.1.1.1.1.1.1.0',  // upsBasicIdentModel
  identFirmware:     '1.3.6.1.4.1.318.1.1.1.1.2.1.0',  // upsAdvIdentFirmwareRevision
  batteryStatus:     '1.3.6.1.4.1.318.1.1.1.2.1.1.0',  // upsBasicBatteryStatus (1=unknown,2=normal,3=low,4=depleted)
  timeOnBattery:     '1.3.6.1.4.1.318.1.1.1.2.1.2.0',  // upsBasicBatteryTimeOnBattery (TimeTicks)
  batteryRuntime:    '1.3.6.1.4.1.318.1.1.1.2.2.3.0',  // upsAdvBatteryRunTimeRemaining (TimeTicks → minutes)
  batteryCharge:     '1.3.6.1.4.1.318.1.1.1.2.2.1.0',  // upsAdvBatteryCapacity (percent)
  batteryTemp:       '1.3.6.1.4.1.318.1.1.1.2.2.2.0',  // upsAdvBatteryTemperature (celsius)
  batteryReplace:    '1.3.6.1.4.1.318.1.1.1.2.2.4.0',  // upsAdvBatteryReplaceIndicator (1=noReplace, 2=needsReplace)
  inputVoltage:      '1.3.6.1.4.1.318.1.1.1.3.2.1.0',  // upsAdvInputLineVoltage (RMS)
  outputSource:      '1.3.6.1.4.1.318.1.1.1.4.1.1.0',  // upsBasicOutputStatus (1=unknown,2=onLine,3=onBattery,4=onSmartBoost,5=timedSleeping,6=softwareBypass,7=off,8=rebooting,9=switchedBypass,10=hardwareFailureBypass,11=sleepingUntilPowerReturn,12=onSmartTrim)
  outputVoltage:     '1.3.6.1.4.1.318.1.1.1.4.2.1.0',  // upsAdvOutputVoltage
  outputLoad:        '1.3.6.1.4.1.318.1.1.1.4.2.3.0',  // upsAdvOutputLoad (percent of capacity)
};

function isApcVendor(device) {
  if (device.oid_profile === 'apc-powernet') return true;
  if (device.oid_profile === 'ups-mib') return false;
  // auto: vendor or model
  const v = (device.vendor || '').toLowerCase();
  if (v.includes('apc') || v.includes('schneider')) return true;
  const m = (device.model || '').toUpperCase();
  if (/^(SR|SRT|SMART-UPS|SMC|SUA|SURTA|SYMMETRA|GALAXY)/.test(m)) return true;
  return false;
}

function selectOidProfile(device) {
  return isApcVendor(device) ? OID_APC_POWERNET : OID_UPS_MIB;
}

function authProtocolOf(name) {
  if (!name || name === 'none') return null;
  return ({
    md5: snmp.AuthProtocols.md5,
    sha: snmp.AuthProtocols.sha,
    sha224: snmp.AuthProtocols.sha224,
    sha256: snmp.AuthProtocols.sha256,
    sha384: snmp.AuthProtocols.sha384,
    sha512: snmp.AuthProtocols.sha512,
  })[name.toLowerCase()] || snmp.AuthProtocols.sha;
}

function privProtocolOf(name) {
  if (!name || name === 'none') return null;
  return ({
    des: snmp.PrivProtocols.des,
    aes: snmp.PrivProtocols.aes,
    aes256b: snmp.PrivProtocols.aes256b,
    aes256r: snmp.PrivProtocols.aes256r,
  })[name.toLowerCase()] || snmp.PrivProtocols.aes;
}

/**
 * SNMP 세션 생성 — v2c 또는 v3 자동 선택
 */
function createSession(device, opts = {}) {
  const { timeout = 5000, retries = 1 } = opts;
  const port = device.snmp_port || 161;
  const target = device.ip;

  const baseOpts = { port, retries, timeout };

  if ((device.snmp_version || 'v2c') === 'v3') {
    if (!device.snmp_v3_user) {
      throw new Error('SNMPv3 selected but snmp_v3_user not set');
    }
    const auth = authProtocolOf(device.snmp_v3_auth_protocol);
    const priv = privProtocolOf(device.snmp_v3_priv_protocol);
    const securityLevel = priv ? snmp.SecurityLevel.authPriv
                        : auth ? snmp.SecurityLevel.authNoPriv
                        :        snmp.SecurityLevel.noAuthNoPriv;

    const user = {
      name: device.snmp_v3_user,
      level: securityLevel,
      authProtocol: auth || snmp.AuthProtocols.none,
      authKey: device.snmp_v3_auth_password || '',
      privProtocol: priv || snmp.PrivProtocols.none,
      privKey: device.snmp_v3_priv_password || '',
    };
    return snmp.createV3Session(target, user, { ...baseOpts, version: snmp.Version3 });
  }

  // v1 또는 v2c (community 기반)
  const version = (device.snmp_version || 'v2c') === 'v1' ? snmp.Version1 : snmp.Version2c;
  return snmp.createSession(target, device.snmp_community || 'public', {
    ...baseOpts,
    version,
  });
}

module.exports = { createSession, OID_UPS_MIB, OID_APC_POWERNET, selectOidProfile, isApcVendor, authProtocolOf, privProtocolOf };
