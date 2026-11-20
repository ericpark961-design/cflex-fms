#!/usr/bin/env bash
# HAEA 미러 랩 생성 — 다시 돌려도 안전하다(있는 것은 건너뛴다).
# 만든 뒤 VM 은 켜진 상태다. 안 쓸 때는 ./down.sh. 매일 SHUTDOWN_UTC 에 자동 종료된다.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
. "$HERE/lab.env"
STATE="$HERE/.state"; mkdir -p "$STATE"
az() { command az "$@" --subscription "$SUB" --only-show-errors; }
log() { printf '\n== %s\n' "$*"; }

# ── 0. SSH 키 (랩 전용) ──────────────────────────────────────────────
if [ ! -f "$SSH_KEY" ]; then
  log "랩 전용 SSH 키 생성: $SSH_KEY"
  ssh-keygen -t ed25519 -N '' -C cflex-haea-lab -f "$SSH_KEY" >/dev/null
fi

# ── 1. 리소스 그룹 · 네트워크 ────────────────────────────────────────
log "리소스 그룹 $RG ($LOC)"
az group create -n "$RG" -l "$LOC" --tags $TAGS -o none

log "NSG"
az network nsg create -g "$RG" -n nsg-fms -o none
# HAEA: 인터넷 없음. 4 VM 의 밖으로 가는 길은 프록시(svc) 하나뿐이어야 한다.
az network nsg rule create -g "$RG" --nsg-name nsg-fms -n deny-internet-out --priority 4000 \
  --direction Outbound --access Deny --protocol '*' --destination-address-prefixes Internet --destination-port-ranges '*' -o none
az network nsg create -g "$RG" -n nsg-nmc -o none
az network nsg rule create -g "$RG" --nsg-name nsg-nmc -n deny-internet-out --priority 4000 \
  --direction Outbound --access Deny --protocol '*' --destination-address-prefixes Internet --destination-port-ranges '*' -o none
az network nsg create -g "$RG" -n nsg-svc -o none
az network nsg rule create -g "$RG" --nsg-name nsg-svc -n ssh-from-operator --priority 300 \
  --direction Inbound --access Allow --protocol Tcp --source-address-prefixes "$MY_IP/32" --destination-port-ranges 22 -o none

# NMC 대역은 VNet 밖 주소라 기본 규칙(VirtualNetwork 태그)에 안 걸린다 — 양방향을 명시한다.
# 폴링/점검: snet-fms → NMC (161/443),  trap: NMC → snet-fms (162/1162)
az network nsg rule create -g "$RG" --nsg-name nsg-fms -n fms-to-nmc --priority 200 --direction Outbound --access Allow \
  --protocol '*' --source-address-prefixes "$SNET_FMS" --destination-address-prefixes $NMC_ROUTES --destination-port-ranges '*' -o none
az network nsg rule create -g "$RG" --nsg-name nsg-fms -n nmc-to-fms --priority 200 --direction Inbound --access Allow \
  --protocol '*' --source-address-prefixes $NMC_ROUTES --destination-address-prefixes "$SNET_FMS" --destination-port-ranges '*' -o none
az network nsg rule create -g "$RG" --nsg-name nsg-nmc -n fms-to-nmc --priority 200 --direction Inbound --access Allow \
  --protocol '*' --source-address-prefixes "$SNET_FMS" --destination-address-prefixes $NMC_ROUTES --destination-port-ranges '*' -o none
az network nsg rule create -g "$RG" --nsg-name nsg-nmc -n nmc-to-fms --priority 200 --direction Outbound --access Allow \
  --protocol '*' --source-address-prefixes $NMC_ROUTES --destination-address-prefixes "$SNET_FMS" --destination-port-ranges '*' -o none

log "경로 테이블 — NMC VLAN 을 nmcsim 으로"
az network route-table create -g "$RG" -n rt-fms -o none
i=0; for p in $NMC_ROUTES; do i=$((i+1))
  az network route-table route create -g "$RG" --route-table-name rt-fms -n "nmc-$i" \
    --address-prefix "$p" --next-hop-type VirtualAppliance --next-hop-ip-address 10.138.16.20 -o none
done

log "VNet $VNET"
az network vnet create -g "$RG" -n "$VNET" --address-prefixes "$VNET_PREFIX" -o none
az network vnet subnet create -g "$RG" --vnet-name "$VNET" -n snet-fms --address-prefixes "$SNET_FMS" \
  --network-security-group nsg-fms --route-table rt-fms -o none
az network vnet subnet create -g "$RG" --vnet-name "$VNET" -n snet-svc --address-prefixes "$SNET_SVC" \
  --network-security-group nsg-svc -o none
az network vnet subnet create -g "$RG" --vnet-name "$VNET" -n snet-nmc --address-prefixes "$SNET_NMC" \
  --network-security-group nsg-nmc -o none

# ── 2. cloud-init (ASCII 만 — az CLI 가 custom-data 를 latin-1 로 인코딩한다) ──
rhel_init() {  # hostname datadisk_gb mount
  local h=$1 gb=$2 mnt=$3
  cat <<EOF
#cloud-config
hostname: $h
fqdn: $h
preserve_hostname: false
EOF
  if [ "$gb" != 0 ]; then cat <<EOF
disk_setup:
  /dev/disk/azure/scsi1/lun0: { table_type: gpt, layout: true, overwrite: false }
fs_setup:
  - { device: /dev/disk/azure/scsi1/lun0, partition: 1, filesystem: xfs }
mounts:
  - [ /dev/disk/azure/scsi1/lun0-part1, $mnt, xfs, "defaults,nofail", "0", "2" ]
EOF
  fi
  cat <<EOF
runcmd:
  # Satellite stand-in: only dnf reaches RHUI, via the svc proxy. NSG blocks all other egress.
  - grep -q '^proxy=' /etc/dnf/dnf.conf || echo 'proxy=$PROXY' >> /etc/dnf/dnf.conf
  - getenforce > /var/log/lab-selinux.txt
EOF
}
cat > "$STATE/init-svc.yaml" <<'EOF'
#cloud-config
hostname: haea-svc
package_update: true
packages: [squid, nodejs, jq]
write_files:
  - path: /etc/squid/lab-allow.txt
    content: |
      # proxy allowlist (stands in for the HAEA proxy), one per line
      .rhui.microsoft.com
      rhui4-1.microsoft.com
      rhui4-2.microsoft.com
      rhui4-3.microsoft.com
      cflex.fms.support
      archive.ubuntu.com
      azure.archive.ubuntu.com
      security.ubuntu.com
  - path: /etc/squid/squid.conf
    content: |
      # HAEA proxy stand-in: allowlist only; access.log is the netcheck evidence
      http_port 3128
      acl lab src 10.138.0.0/16
      acl allowed dstdomain "/etc/squid/lab-allow.txt"
      acl SSL_ports port 443
      acl CONNECT method CONNECT
      http_access deny CONNECT !SSL_ports
      http_access allow lab allowed
      http_access deny all
      access_log daemon:/var/log/squid/access.log squid
      cache deny all
runcmd:
  - systemctl restart squid
  - systemctl enable squid
EOF
cat > "$STATE/init-nmcsim.yaml" <<EOF
#cloud-config
hostname: haea-nmcsim
apt:
  http_proxy: $PROXY
  https_proxy: $PROXY
package_update: true
packages: [nodejs, snmp]
EOF

# ── 3. VM ────────────────────────────────────────────────────────────
exists() { az vm show -g "$RG" -n "$1" --query name -o tsv >/dev/null 2>&1; }
echo "$NODES" | while read -r name size ip role gb mnt host; do
  [ -z "$name" ] && continue
  if exists "$name"; then log "$name 이미 있음 — 건너뜀"; continue; fi
  log "VM $name ($size, $ip, $role)"
  common=(-g "$RG" -n "$name" --size "$size" --admin-username "$ADMIN" --ssh-key-values "$SSH_KEY.pub"
          --vnet-name "$VNET" --private-ip-address "$ip" --storage-sku StandardSSD_LRS
          --nic-delete-option Delete --os-disk-delete-option Delete --tags $TAGS -o none)
  case $role in
    svc)
      az vm create "${common[@]}" --image "$UBUNTU_IMAGE" --subnet snet-svc --nsg '' \
        --public-ip-address svc-pip --public-ip-sku Standard --custom-data "$STATE/init-svc.yaml" ;;
    nmcsim)
      az vm create "${common[@]}" --image "$UBUNTU_IMAGE" --subnet snet-nmc --nsg '' \
        --public-ip-address '' --custom-data "$STATE/init-nmcsim.yaml"
      # NMC IP 41개를 자기 주소처럼 받으려면 Azure 쪽 IP 전달이 켜져 있어야 한다.
      nic=$(az vm show -g "$RG" -n "$name" --query 'networkProfile.networkInterfaces[0].id' -o tsv)
      az network nic update --ids "$nic" --ip-forwarding true -o none ;;
    rhel-*)
      rhel_init "$host" "$gb" "$mnt" > "$STATE/init-$name.yaml"
      extra=(); [ "$gb" != 0 ] && extra=(--data-disk-sizes-gb "$gb" --data-disk-delete-option Delete)
      az vm create "${common[@]}" --image "$RHEL_IMAGE" --subnet snet-fms --nsg '' \
        --public-ip-address '' --os-disk-size-gb 64 ${extra[@]+"${extra[@]}"} --custom-data "$STATE/init-$name.yaml" ;;
  esac
  az vm auto-shutdown -g "$RG" -n "$name" --time "$SHUTDOWN_UTC" -o none
done

# ── 4. 접속 설정 (Mac → svc 점프 → 나머지) ───────────────────────────
PIP=$(az network public-ip show -g "$RG" -n svc-pip --query ipAddress -o tsv)
{
  echo "# 생성: create.sh — ssh -F $STATE/ssh_config <이름>"
  echo "Host *"
  echo "  User $ADMIN"
  echo "  IdentityFile $SSH_KEY"
  echo "  IdentitiesOnly yes"
  echo "  StrictHostKeyChecking accept-new"
  echo "  UserKnownHostsFile $STATE/known_hosts"
  echo "Host svc"
  echo "  HostName $PIP"
  echo "$NODES" | while read -r name size ip role gb mnt host; do
    [ -z "$name" ] || [ "$name" = svc ] && continue
    printf 'Host %s\n  HostName %s\n  ProxyJump svc\n' "$name" "$ip"
  done
} > "$STATE/ssh_config"

log "완료. 점프 호스트 $PIP — ssh -F $STATE/ssh_config cap01"
