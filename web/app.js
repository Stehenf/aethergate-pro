// AetherGate Pro - Premium Frontend Controller
let appState = {
    nodes: [],
    settings: {},
    activeNodeId: "",
    isConnecting: false,
    currentPage: 1,
    pageSize: 10,
    searchTerm: "",
    ipTypeFilter: "all",
    testingNodeIds: new Set(),
    uptimeInterval: null,
    isFirstLoad: true
};

// Compute API Prefix dynamically based on URL (handles secret path prefix)
const secretPath = window.location.pathname.split("/")[1] || "";
const apiPrefix = secretPath && secretPath !== "index.html" ? `/${secretPath}` : "";

// Track last diagnostic message
let lastDiagnosticMsg = "";

document.addEventListener("DOMContentLoaded", () => {
    initSpotlightEffect();
    initSkeletonLoader();
    fetchNodesData();
    // Start periodic polling every 3.5 seconds for snappier UI updates
    setInterval(fetchNodesData, 3500);
});

// 1. Mouse Spotlight Glow Effect
function initSpotlightEffect() {
    document.addEventListener("mousemove", (e) => {
        const spotlights = document.querySelectorAll(".card.spotlight");
        spotlights.forEach(card => {
            const rect = card.getBoundingClientRect();
            const x = e.clientX - rect.left;
            const y = e.clientY - rect.top;
            card.style.setProperty("--mouse-x", x);
            card.style.setProperty("--mouse-y", y);
        });
    });
}

// 2. Initialize Table Skeleton Loader
function initSkeletonLoader() {
    const tbody = document.getElementById("node-table-body");
    if (!tbody) return;
    
    let skeletonHtml = "";
    for (let i = 0; i < 5; i++) {
        skeletonHtml += `
            <tr class="skeleton-row">
                <td><div class="skeleton-box" style="width: 60px;"></div></td>
                <td><div class="skeleton-box" style="width: 50px;"></div></td>
                <td><div class="skeleton-box" style="width: 110px;"></div></td>
                <td><div class="skeleton-box" style="width: 80px;"></div></td>
                <td><div class="skeleton-box" style="width: 140px;"></div></td>
                <td><div class="skeleton-box" style="width: 70px;"></div></td>
                <td><div class="skeleton-box" style="width: 80px;"></div></td>
                <td><div class="skeleton-box" style="width: 120px;"></div></td>
            </tr>
        `;
    }
    tbody.innerHTML = skeletonHtml;
}

// 3. Main Data Poller
async function fetchNodesData() {
    try {
        const res = await fetch(`${apiPrefix}/api/nodes`);
        if (!res.ok) {
            if (res.status === 401) {
                // Session expired or unauthorized, reload to login
                window.location.reload();
            }
            return;
        }
        
        const data = await res.json();
        appState.nodes = data.nodes || [];
        
        // Sync configuration and states
        const oldSettings = JSON.stringify(appState.settings);
        appState.settings = data.state || {};
        appState.activeNodeId = appState.settings.active_openvpn_node_id || "";
        appState.isConnecting = appState.settings.is_connecting || false;
        
        // Populate settings form initially or if config changes
        if (oldSettings !== JSON.stringify(appState.settings)) {
            syncSettingsForm();
        }

        // Add to diagnostic console log box
        handleDiagnosticLogs();

        renderUIPanels();
        appState.isFirstLoad = false;
    } catch (err) {
        console.error("Failed to poll server nodes:", err);
    }
}

// Sync form values
function syncSettingsForm() {
    const routingMode = document.getElementById("setting-routing-mode");
    const forceCountry = document.getElementById("setting-force-country");
    const fixedNode = document.getElementById("setting-fixed-node");
    const scamalytics = document.getElementById("setting-scamalytics");
    const connEnabled = document.getElementById("setting-connection-enabled");
    
    if (routingMode) routingMode.value = appState.settings.routing_mode || "auto";
    if (forceCountry) forceCountry.value = appState.settings.force_country || "";
    if (fixedNode) fixedNode.value = appState.settings.fixed_node_id || "";
    
    if (scamalytics) {
        scamalytics.value = appState.settings.scamalytics_threshold !== undefined ? appState.settings.scamalytics_threshold : 10;
        document.getElementById("scamalytics-val").textContent = scamalytics.value;
    }
    
    if (connEnabled) connEnabled.checked = appState.settings.connection_enabled || false;
    
    const usernameEl = document.getElementById("setting-username");
    if (usernameEl && appState.settings.username && !usernameEl.value) {
        usernameEl.value = appState.settings.username;
    }
    
    toggleSettingsVisibility();
}

function toggleSettingsVisibility() {
    const routingModeEl = document.getElementById("setting-routing-mode");
    if (!routingModeEl) return;
    const mode = routingModeEl.value;
    
    const regionGroup = document.getElementById("group-force-country");
    const nodeGroup = document.getElementById("group-fixed-node");
    
    if (regionGroup) regionGroup.style.display = (mode === "fixed_region") ? "block" : "none";
    if (nodeGroup) nodeGroup.style.display = (mode === "fixed_ip") ? "block" : "none";
}

// Save Settings Event Handler
async function saveSettings(event) {
    if (event) event.preventDefault();
    
    const payload = {
        routing_mode: document.getElementById("setting-routing-mode").value,
        force_country: document.getElementById("setting-force-country").value.trim().toUpperCase(),
        fixed_node_id: document.getElementById("setting-fixed-node").value,
        scamalytics_threshold: parseInt(document.getElementById("setting-scamalytics").value),
        connection_enabled: document.getElementById("setting-connection-enabled").checked
    };
    
    try {
        const res = await fetch(`${apiPrefix}/api/settings`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload)
        });
        const data = await res.json();
        
        // Show diagnostic status update rather than raw alert
        addDiagnosticLine(`[网关设置已保存]: 模式=${payload.routing_mode}, 欺诈限制=${payload.scamalytics_threshold}, 总闸=${payload.connection_enabled}`);
        fetchNodesData();
    } catch (err) {
        addDiagnosticLine(`[设置保存失败]: ${err}`);
    }
}

// Update Credentials Event Handler
async function updateCredentials(event) {
    if (event) event.preventDefault();
    
    const username = document.getElementById("setting-username").value.trim();
    const password = document.getElementById("setting-password").value.trim();
    
    if (!username || !password) {
        alert("用户名和密码不能为空！");
        return;
    }
    
    const payload = {
        username: username,
        password: password
    };
    
    try {
        const res = await fetch(`${apiPrefix}/api/settings`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload)
        });
        
        if (res.status === 401) {
            alert("会话已失效，请重新登录！");
            window.location.reload();
            return;
        }
        
        const data = await res.json();
        if (res.ok) {
            if (data.require_relogin) {
                alert("登录凭证（用户名/密码）已更新！请使用新凭证重新登录。");
                window.location.reload();
            } else {
                addDiagnosticLine(`[凭证更新成功]: 用户名已变更为 ${username}`);
            }
        } else {
            alert(`凭证更新失败: ${data.error || "未知错误"}`);
        }
    } catch (err) {
        addDiagnosticLine(`[凭证更新失败]: ${err}`);
        alert(`凭证更新请求失败: ${err}`);
    }
}

// 4. Render UI elements
function renderUIPanels() {
    // 1. Header Status Update
    const dot = document.getElementById("global-status-dot");
    const text = document.getElementById("global-status-text");
    const desc = document.getElementById("global-status-sub");
    const btnDisconnect = document.getElementById("btn-quick-disconnect");
    
    if (appState.activeNodeId && !appState.isConnecting) {
        if (dot) dot.className = "status-dot dot-online";
        if (text) text.textContent = "已建立隔离隧道";
        if (desc) desc.textContent = "网关运行正常，全部出口流量经隔离路由分发";
        if (btnDisconnect) btnDisconnect.disabled = false;
    } else if (appState.isConnecting) {
        if (dot) dot.className = "status-dot dot-connecting";
        if (text) text.textContent = "正在建立连接...";
        if (desc) desc.textContent = appState.settings.last_check_message || "正在初始化 OpenVPN 安全隧道";
        if (btnDisconnect) btnDisconnect.disabled = false;
    } else {
        if (dot) dot.className = "status-dot dot-offline";
        if (text) text.textContent = "未启动";
        if (desc) desc.textContent = "网关未工作。开启右下角「总闸」即可启用自愈路由";
        if (btnDisconnect) btnDisconnect.disabled = true;
    }
    
    // 2. Active Card Info
    const activeNode = appState.nodes.find(n => n.id === appState.activeNodeId);
    if (activeNode) {
        document.getElementById("active-node-id").textContent = activeNode.id;
        document.getElementById("active-ip").textContent = activeNode.ip;
        
        const loc = activeNode.location || activeNode.country || "-";
        const flag = getFlagEmoji(activeNode.country);
        document.getElementById("active-location").innerHTML = `<span class="flag-icon">${flag}</span> ${loc}`;
        
        document.getElementById("active-latency").textContent = (activeNode.latency_ms && activeNode.latency_ms < 99999) ? `${activeNode.latency_ms} ms` : "正在测速";
        document.getElementById("active-ip-type").innerHTML = `<span class="type-badge">${translateIpType(activeNode.ip_type)}</span>`;
        document.getElementById("active-isp").textContent = activeNode.owner || activeNode.as_name || "-";
        document.getElementById("active-asn").textContent = activeNode.asn || "-";
        
        const score = activeNode.scamalytics_score;
        let scoreHTML = "-";
        if (score !== null && score !== undefined && score >= 0) {
            const levelClass = score >= 50 ? "risk-high" : (score >= 10 ? "risk-med" : "risk-low");
            scoreHTML = `<span class="risk-badge ${levelClass}">${score} / 100 (${translateRisk(score)})</span>`;
        } else if (score === -1) {
            scoreHTML = `<span class="risk-badge risk-unknown">检测失败</span>`;
        }
        document.getElementById("active-scamalytics").innerHTML = scoreHTML;
        
        // Start Uptime Stopwatch
        if (!appState.uptimeInterval) {
            const startTime = appState.settings.connected_at || (Date.now() / 1000);
            appState.uptimeInterval = setInterval(() => {
                const diff = Math.floor((Date.now() / 1000) - startTime);
                if (diff < 0) return;
                const hours = String(Math.floor(diff / 3600)).padStart(2, '0');
                const minutes = String(Math.floor((diff % 3600) / 60)).padStart(2, '0');
                const seconds = String(diff % 60).padStart(2, '0');
                document.getElementById("active-uptime").textContent = `${hours}:${minutes}:${seconds}`;
            }, 1000);
        }
    } else {
        document.getElementById("active-node-id").textContent = "-";
        document.getElementById("active-ip").textContent = "-";
        document.getElementById("active-location").textContent = "-";
        document.getElementById("active-latency").textContent = "-";
        document.getElementById("active-ip-type").textContent = "-";
        document.getElementById("active-isp").textContent = "-";
        document.getElementById("active-asn").textContent = "-";
        document.getElementById("active-scamalytics").textContent = "-";
        document.getElementById("active-uptime").textContent = "00:00:00";
        if (appState.uptimeInterval) {
            clearInterval(appState.uptimeInterval);
            appState.uptimeInterval = null;
        }
    }
    
    // Update visual connection topology mapping
    updateVisualTopology(activeNode);
    
    // 3. Render Nodes Table
    renderNodesTable();
}

// Diagnostic Console Logs Handler
function handleDiagnosticLogs() {
    const box = document.getElementById("diagnostic-log-box");
    if (!box) return;

    // Remove placeholder on first payload
    const placeholder = box.querySelector(".diagnostic-placeholder");
    if (placeholder && appState.settings.last_check_message) {
        placeholder.remove();
    }

    if (appState.settings.last_check_message && appState.settings.last_check_message !== lastDiagnosticMsg) {
        lastDiagnosticMsg = appState.settings.last_check_message;
        addDiagnosticLine(lastDiagnosticMsg);
    }
    
    // If not connected and no check msg, add idle log once
    if (!appState.activeNodeId && !appState.isConnecting && box.children.length === 0) {
        addDiagnosticLine("系统就绪。等待用户开启总闸连接外部节点网络...");
    }
}

function addDiagnosticLine(text) {
    const box = document.getElementById("diagnostic-log-box");
    if (!box) return;
    
    const timeStr = new Date().toLocaleTimeString("zh-CN", { hour12: false });
    const line = document.createElement("div");
    line.className = "log-line";
    line.innerHTML = `<span class="log-time">[${timeStr}]</span> ${text}`;
    
    box.appendChild(line);
    // Auto Scroll to bottom
    box.scrollTop = box.scrollHeight;
}

// 5. Render Nodes Table
function renderNodesTable() {
    const body = document.getElementById("node-table-body");
    if (!body) return;
    
    // Apply client filters
    let filtered = appState.nodes.filter(n => {
        // Search Term: IP or Country name match
        if (appState.searchTerm) {
            const query = appState.searchTerm.toLowerCase();
            const ipMatch = n.ip && n.ip.toLowerCase().includes(query);
            const countryMatch = n.country && n.country.toLowerCase().includes(query);
            const locationMatch = n.location && n.location.toLowerCase().includes(query);
            if (!ipMatch && !countryMatch && !locationMatch) return false;
        }
        // IP Type Dropdown filter
        if (appState.ipTypeFilter !== "all" && n.ip_type !== appState.ipTypeFilter) {
            return false;
        }
        return true;
    });

    // Sort: Active node first, then by latency (ascending)
    filtered.sort((a, b) => {
        const aActive = a.id === appState.activeNodeId;
        const bActive = b.id === appState.activeNodeId;
        if (aActive) return -1;
        if (bActive) return 1;
        return a.latency_ms - b.latency_ms;
    });

    document.getElementById("filtered-count").textContent = filtered.length;

    // Pagination bounds
    const totalPages = Math.ceil(filtered.length / appState.pageSize) || 1;
    if (appState.currentPage > totalPages) appState.currentPage = totalPages;
    
    const startIndex = (appState.currentPage - 1) * appState.pageSize;
    const endIndex = Math.min(startIndex + appState.pageSize, filtered.length);
    
    document.getElementById("page-start").textContent = filtered.length > 0 ? startIndex + 1 : 0;
    document.getElementById("page-end").textContent = endIndex;

    // Update pagination button disabled states
    const btnPrev = document.getElementById("btn-prev");
    const btnNext = document.getElementById("btn-next");
    if (btnPrev) btnPrev.disabled = (appState.currentPage === 1);
    if (btnNext) btnNext.disabled = (appState.currentPage === totalPages);

    const pageNodes = filtered.slice(startIndex, endIndex);

    if (pageNodes.length === 0) {
        if (appState.isFirstLoad) {
            // Keep skeleton loader on first loading
            return;
        }
        body.innerHTML = `<tr><td colspan="8" class="text-center" style="color: var(--text-secondary); padding: 3rem;">没有找到匹配的可用代理节点</td></tr>`;
        return;
    }

    body.innerHTML = pageNodes.map(n => {
        const isCurrentActive = n.id === appState.activeNodeId;
        const rowClass = isCurrentActive ? 'class="active-row"' : '';
        const badgeClass = isCurrentActive ? 'status-available' : `status-${n.probe_status || 'not_checked'}`;
        const badgeText = isCurrentActive ? '已连接' : translateStatus(n.probe_status);
        
        // Latency formatting
        let latencyText = "-";
        if (n.latency_ms && n.latency_ms < 99999) {
            latencyText = `<span class="text-success" style="font-weight:700;">${n.latency_ms} ms</span>`;
        } else if (n.ping) {
            latencyText = `<span class="text-secondary" style="font-size:11px;">${n.ping} ms (原始)</span>`;
        }
        
        // Scamalytics rendering
        const score = n.scamalytics_score;
        let scoreTag = "-";
        if (score !== null && score !== undefined && score >= 0) {
            const scoreClass = score >= 50 ? "risk-high" : (score >= 10 ? "risk-med" : "risk-low");
            scoreTag = `<span class="risk-badge ${scoreClass}">${score} (${translateRisk(score)})</span>`;
        } else if (score === -1) {
            scoreTag = `<span class="risk-badge risk-unknown">检测失败</span>`;
        }
        
        // Connect button behavior
        let connButton = "";
        if (isCurrentActive) {
            connButton = `<button class="btn btn-secondary btn-sm" disabled>工作节点</button>`;
        } else {
            const isDisabled = appState.isConnecting || !appState.settings.connection_enabled;
            connButton = `<button class="btn btn-primary btn-sm" ${isDisabled ? 'disabled' : ''} onclick="connectNode(event, '${n.id}')">接入</button>`;
        }
        
        // Test button behavior
        const isTesting = appState.testingNodeIds.has(n.id);
        const testButton = `<button class="btn btn-secondary btn-sm" ${isTesting ? 'disabled' : ''} onclick="testNode(event, this, '${n.id}')">${isTesting ? '正在探测' : '测速'}</button>`;
        
        const flag = getFlagEmoji(n.country);
        
        return `<tr ${rowClass} ondblclick="lockNodeId('${n.id}')" title="双击直接锁定此 IP">
            <td><span class="status-badge ${badgeClass}">${badgeText}</span></td>
            <td>${latencyText}</td>
            <td class="mono">${n.ip}</td>
            <td><span class="flag-icon">${flag}</span> ${n.location || n.country || "-"}</td>
            <td class="mono" style="font-size: 11px; color: var(--text-secondary); max-width: 140px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${n.owner || n.as_name || "-"}</td>
            <td>${scoreTag}</td>
            <td><span class="type-badge">${translateIpType(n.ip_type)}</span></td>
            <td>
                <div class="actions-cell">
                    ${testButton}
                    ${connButton}
                </div>
            </td>
        </tr>`;
    }).join("");
}

function applyFilters() {
    appState.searchTerm = document.getElementById("filter-search").value;
    appState.ipTypeFilter = document.getElementById("filter-type").value;
    appState.currentPage = 1; // reset page
    renderNodesTable();
}

function nextPage() {
    const filteredCount = appState.nodes.filter(n => {
        if (appState.searchTerm && !n.ip.toLowerCase().includes(appState.searchTerm.toLowerCase()) && !n.country.toLowerCase().includes(appState.searchTerm.toLowerCase())) return false;
        if (appState.ipTypeFilter !== "all" && n.ip_type !== appState.ipTypeFilter) return false;
        return true;
    }).length;
    
    const totalPages = Math.ceil(filteredCount / appState.pageSize) || 1;
    if (appState.currentPage < totalPages) {
        appState.currentPage++;
        renderNodesTable();
    }
}

function prevPage() {
    if (appState.currentPage > 1) {
        appState.currentPage--;
        renderNodesTable();
    }
}

function lockNodeId(nodeId) {
    const fixedNode = document.getElementById("setting-fixed-node");
    if (!fixedNode) return;
    fixedNode.value = nodeId;
    
    // Automatically switch routing mode input to fixed_ip for ease of use
    document.getElementById("setting-routing-mode").value = "fixed_ip";
    toggleSettingsVisibility();
    
    addDiagnosticLine(`[网关选路]: 双击节点已复制并锁定 ID=${nodeId.substring(0, 15)}...`);
    
    // Save settings automatically on double click lock
    saveSettings();
}

async function connectNode(event, nodeId) {
    if (event) event.stopPropagation();
    if (appState.isConnecting) return;
    
    addDiagnosticLine(`[控制面板]: 发起强制切换到节点=${nodeId.substring(0, 12)}...`);
    try {
        const res = await fetch(`${apiPrefix}/api/connect`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ node_id: nodeId })
        });
        fetchNodesData();
    } catch (err) {
        addDiagnosticLine(`[切换连接失败]: ${err}`);
    }
}

async function disconnectNode() {
    addDiagnosticLine("[控制面板]: 手动断开当前网络隧道连接");
    try {
        await fetch(`${apiPrefix}/api/disconnect`, { method: "POST" });
        fetchNodesData();
    } catch (err) {
        addDiagnosticLine(`[断开隧道失败]: ${err}`);
    }
}

async function testNode(event, button, nodeId) {
    if (event) event.stopPropagation();
    
    appState.testingNodeIds.add(nodeId);
    button.disabled = true;
    button.textContent = "测试中...";
    
    addDiagnosticLine(`[网络测速]: 正在测试节点 IP=${nodeId.split('_')[1]} 的 TCP 握手握手延迟...`);
    try {
        await fetch(`${apiPrefix}/api/test_node`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ node_id: nodeId })
        });
        
        // Remove from testing status after a short delay
        setTimeout(() => {
            appState.testingNodeIds.delete(nodeId);
            fetchNodesData();
        }, 5000);
    } catch (err) {
        appState.testingNodeIds.delete(nodeId);
        button.disabled = false;
        button.textContent = "测速";
    }
}

// Helpers
function translateStatus(status) {
    const dict = { "available": "可用", "unavailable": "不可用", "not_checked": "待检测" };
    return dict[status] || "待检测";
}

function translateIpType(type) {
    const dict = { "residential": "住宅", "mobile": "移动", "hosting": "机房", "datacenter": "机房", "proxy": "代理", "untested": "待检测", "unknown": "未知" };
    return dict[type] || "待检测";
}

function translateRisk(score) {
    if (score < 0) return "未知";
    if (score >= 50) return "高风险";
    if (score >= 10) return "中风险";
    return "低风险";
}

// Flag Emoji mapping helper
function getFlagEmoji(countryCode) {
    if (!countryCode) return "🌐";
    const codePoints = countryCode
        .toUpperCase()
        .split('')
        .map(char =>  127397 + char.charCodeAt(0));
    try {
        return String.fromCodePoint(...codePoints);
    } catch (e) {
        return "🌐";
    }
}

// Update visual connection topology mapping based on tunnel state
function updateVisualTopology(activeNode) {
    const linkVpn = document.getElementById("link-to-vpn");
    const linkInternet = document.getElementById("link-to-internet");
    const vpnNode = document.getElementById("flow-gateway-node");
    const destNode = document.getElementById("flow-dest-node");
    
    const vpnLabel = document.getElementById("flow-vpn-label");
    const vpnIp = document.getElementById("flow-vpn-ip");
    const destIp = document.getElementById("flow-dest-ip");
    
    if (!linkVpn || !linkInternet || !vpnNode || !destNode || !vpnLabel || !vpnIp || !destIp) return;
    
    if (activeNode) {
        if (appState.isConnecting) {
            // Connecting state
            linkVpn.className = "network-link connecting";
            vpnNode.className = "network-node gateway-node connecting";
            vpnLabel.textContent = activeNode.location || activeNode.country || "VPN 节点";
            vpnIp.textContent = "连接中...";
            
            linkInternet.className = "network-link";
            destNode.className = "network-node destination-node";
            destIp.textContent = "Internet";
        } else {
            // Fully connected state
            linkVpn.className = "network-link connected";
            vpnNode.className = "network-node gateway-node connected";
            vpnLabel.textContent = activeNode.location || activeNode.country || "VPN 节点";
            vpnIp.textContent = activeNode.ip || "-";
            
            linkInternet.className = "network-link connected";
            destNode.className = "network-node destination-node active";
            destIp.textContent = "已就绪";
        }
    } else {
        if (appState.isConnecting) {
            // Connecting without active node details yet
            linkVpn.className = "network-link connecting";
            vpnNode.className = "network-node gateway-node connecting";
            vpnLabel.textContent = "VPN 节点";
            vpnIp.textContent = "正在准备...";
            
            linkInternet.className = "network-link";
            destNode.className = "network-node destination-node";
            destIp.textContent = "Internet";
        } else {
            // Idle / Offline
            linkVpn.className = "network-link";
            vpnNode.className = "network-node gateway-node";
            vpnLabel.textContent = "VPN 节点";
            vpnIp.textContent = "-";
            
            linkInternet.className = "network-link";
            destNode.className = "network-node destination-node";
            destIp.textContent = "Internet";
        }
    }
}

// Clear the diagnostic console log contents
function clearConsoleLogs() {
    const box = document.getElementById("diagnostic-log-box");
    if (box) {
        box.innerHTML = '<div class="diagnostic-placeholder">正在等待网关发送系统诊断流...</div>';
    }
    lastDiagnosticMsg = "";
    addDiagnosticLine("连接日志诊断流已手动清除。");
}
