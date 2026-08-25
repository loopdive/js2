#!/bin/bash
set -euo pipefail  # Exit on error, undefined vars, and pipeline failures
IFS=$'\n\t'       # Stricter word splitting

# 1. Extract Docker DNS info BEFORE any flushing
DOCKER_DNS_RULES=$(iptables-save -t nat | grep "127\.0\.0\.11" || true)

# Flush existing rules and delete existing ipsets
iptables -F
iptables -X
iptables -t nat -F
iptables -t nat -X
iptables -t mangle -F
iptables -t mangle -X
ipset destroy allowed-domains 2>/dev/null || true

# Reset chain POLICIES to ACCEPT. `iptables -F` clears the RULES but NOT the
# chain policy, and this script is re-run on every container start/attach via
# postStartCommand. On a re-run the policies set at the bottom of this file are
# still DROP while every ACCEPT rule has just been flushed away -- a total
# blackout. Everything below would then fail starting with the GitHub-meta
# fetch, and `set -e` would abort, leaving the container with DROP policies and
# no rules at all (no network until it is recreated). Restoring ACCEPT here lets
# the script reach the network it needs to rebuild the allowlist; the DROP
# policies are re-applied further down once the allowlist is populated.
iptables -P INPUT ACCEPT
iptables -P FORWARD ACCEPT
iptables -P OUTPUT ACCEPT

# 2. Selectively restore ONLY internal Docker DNS resolution
if [ -n "$DOCKER_DNS_RULES" ]; then
    echo "Restoring Docker DNS rules..."
    iptables -t nat -N DOCKER_OUTPUT 2>/dev/null || true
    iptables -t nat -N DOCKER_POSTROUTING 2>/dev/null || true
    echo "$DOCKER_DNS_RULES" | xargs -L 1 iptables -t nat
else
    echo "No Docker DNS rules to restore"
fi

# First allow DNS and localhost before any restrictions
# Allow outbound DNS
iptables -A OUTPUT -p udp --dport 53 -j ACCEPT
# Allow inbound DNS responses
iptables -A INPUT -p udp --sport 53 -j ACCEPT
# Allow outbound SSH
iptables -A OUTPUT -p tcp --dport 22 -j ACCEPT
# Allow inbound SSH responses
iptables -A INPUT -p tcp --sport 22 -m state --state ESTABLISHED -j ACCEPT
# Allow inbound SSH on port 2222
iptables -A INPUT -p tcp --dport 2222 -j ACCEPT
iptables -A OUTPUT -p tcp --sport 2222 -m state --state ESTABLISHED -j ACCEPT
# Allow localhost
iptables -A INPUT -i lo -j ACCEPT
iptables -A OUTPUT -o lo -j ACCEPT

# Create ipset with CIDR support
ipset create allowed-domains hash:net

# Fetch GitHub meta information and aggregate + add their IP ranges
echo "Fetching GitHub IP ranges..."
gh_ranges=$(curl -s https://api.github.com/meta)
if [ -z "$gh_ranges" ]; then
    echo "ERROR: Failed to fetch GitHub IP ranges"
    exit 1
fi

if ! echo "$gh_ranges" | jq -e '.web and .api and .git' >/dev/null; then
    echo "ERROR: GitHub API response missing required fields"
    exit 1
fi

echo "Processing GitHub IPs..."
while read -r cidr; do
    if [[ ! "$cidr" =~ ^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}/[0-9]{1,2}$ ]]; then
        echo "ERROR: Invalid CIDR range from GitHub meta: $cidr"
        exit 1
    fi
    echo "Adding GitHub range $cidr"
    ipset add -exist allowed-domains "$cidr"
done < <(echo "$gh_ranges" | jq -r '(.web + .api + .git)[]' | aggregate -q)

# Resolve and add other allowed domains.
#
# A domain that no longer resolves must NOT abort the whole script: third-party
# hostnames get retired (statsig.anthropic.com lost its A record and silently
# broke every run of this file), and killing the firewall setup over one dead
# hostname is far worse than leaving that one hostname unreachable. Only the
# domains this container genuinely cannot work without are fatal.
REQUIRED_DOMAINS="api.anthropic.com registry.npmjs.org"
unresolved=""

for domain in \
    "registry.npmjs.org" \
    "api.anthropic.com" \
    "api.openai.com" \
    "auth.openai.com" \
    "sentry.io" \
    "statsig.anthropic.com" \
    "statsig.com" \
    "marketplace.visualstudio.com" \
    "vscode.blob.core.windows.net" \
    "update.code.visualstudio.com"; do
    echo "Resolving $domain..."
    ips=$(dig +noall +answer A "$domain" | awk '$4 == "A" {print $5}')
    if [ -z "$ips" ]; then
        case " $REQUIRED_DOMAINS " in
            *" $domain "*)
                echo "ERROR: Failed to resolve REQUIRED domain $domain"
                exit 1
                ;;
        esac
        echo "WARNING: Failed to resolve $domain - skipping (not required)"
        unresolved="$unresolved $domain"
        continue
    fi
    
    while read -r ip; do
        if [[ ! "$ip" =~ ^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}$ ]]; then
            echo "ERROR: Invalid IP from DNS for $domain: $ip"
            exit 1
        fi
        echo "Adding $ip for $domain"
        ipset add -exist allowed-domains "$ip"
    done < <(echo "$ips")
done

if [ -n "$unresolved" ]; then
    echo "NOTE: the following domains did not resolve and are NOT allowlisted:$unresolved"
fi

# Get host IP from default route
HOST_IP=$(ip route | grep default | cut -d" " -f3)
if [ -z "$HOST_IP" ]; then
    echo "ERROR: Failed to detect host IP"
    exit 1
fi

HOST_NETWORK=$(echo "$HOST_IP" | sed "s/\.[0-9]*$/.0\/24/")
echo "Host network detected as: $HOST_NETWORK"

# ttyd (port 7681) is an UNAUTHENTICATED writable web terminal, so it must not
# be broadly reachable. WHERE that gets enforced depends on the host:
#
#   * Native Linux Docker DNATs published ports and PRESERVES the client's
#     source address, so the source filter below does what it says.
#   * Docker Desktop (macOS/Windows) forwards through a userland proxy that
#     REWRITES the source: every client arrives as one fixed proxy address
#     (measured 2026-08-20: 172.66.144.201) whether it came from loopback, the
#     LAN, or Tailscale. A source filter cannot discriminate there - it drops
#     ttyd for everyone, which is exactly what happened once this script
#     started applying again. On such a host the only layer that sees the real
#     client is the host port BINDING, so restrict `appPort` in
#     devcontainer.json (bind 7681 to loopback or to the Tailscale address)
#     rather than pretending to filter here.
#
# Default is therefore to allow 7681 here and let the binding restrict it. Set
# TTYD_SOURCE_FILTER=1 on a source-preserving host to filter in-container too.
if [ "${TTYD_SOURCE_FILTER:-0}" = "1" ]; then
    iptables -A INPUT -p tcp --dport 7681 -s 100.64.0.0/10 -j ACCEPT
    iptables -A INPUT -p tcp --dport 7681 -j DROP
else
    iptables -A INPUT -p tcp --dport 7681 -j ACCEPT
fi

# Set up remaining iptables rules
iptables -A INPUT -s "$HOST_NETWORK" -j ACCEPT
iptables -A OUTPUT -d "$HOST_NETWORK" -j ACCEPT

# Set default policies to DROP first
iptables -P INPUT DROP
iptables -P FORWARD DROP
iptables -P OUTPUT DROP

# First allow established connections for already approved traffic
iptables -A INPUT -m state --state ESTABLISHED,RELATED -j ACCEPT
iptables -A OUTPUT -m state --state ESTABLISHED,RELATED -j ACCEPT

# Then allow only specific outbound traffic to allowed domains
iptables -A OUTPUT -m set --match-set allowed-domains dst -j ACCEPT

# Explicitly REJECT all other outbound traffic for immediate feedback
iptables -A OUTPUT -j REJECT --reject-with icmp-admin-prohibited

echo "Firewall configuration complete"
echo "Verifying firewall rules..."
if curl --connect-timeout 5 https://example.com >/dev/null 2>&1; then
    echo "ERROR: Firewall verification failed - was able to reach https://example.com"
    exit 1
else
    echo "Firewall verification passed - unable to reach https://example.com as expected"
fi

# Verify GitHub API access
if ! curl --connect-timeout 5 https://api.github.com/zen >/dev/null 2>&1; then
    echo "ERROR: Firewall verification failed - unable to reach https://api.github.com"
    exit 1
else
    echo "Firewall verification passed - able to reach https://api.github.com as expected"
fi
