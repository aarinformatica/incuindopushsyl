document.addEventListener('DOMContentLoaded', () => {
    initIdentification();
    initDigitalClock();
    initPlatformAccess(); 
    initSmartphoneOS(); 
    initSettings(); 
    initMapLoader(); 
    registerServiceWorker(); // Inicializa o Service Worker de notificações nativas
});

// Variáveis globais para o mapa e comunicação remota
let map;
let userMarker;
let watchID;
let serviceWorkerRegistration = null; // Armazena o escopo de registro para notificações

// Configuração de Credenciais do Administrador
const ADMIN_NAME = "alex";
const ADMIN_PASSWORD = "1234"; // Defina aqui a senha desejada para o seu perfil
let isAdminActive = false;

// Controle visual do painel de monitoramento no mapa (Permite que o usuário feche e permaneça fechado)
let isMapPanelManuallyClosed = false;

// Armazenamento da última coordenada válida para suavização de movimento
let lastUserLatLng = null;

// Integração Ably Realtime
const ABLY_KEY = 'zfqwdA.QY0KxQ:_RQcTI6NCeRMNnLLyC8Ebb6Lg50xnDlcwvRv4wQ3H5o';
let ablyClient;
let trackingChannel;
let currentUsernameString = '';
const remoteMarkers = {}; // Guarda a referência dos marcadores de outros usuários

// Estrutura para controle de som de proximidade (Evita loops e bipes infinitos travando o navegador)
let lastAlertTime = 0;
const ALERT_COOLDOWN = 5000; // Intervalo mínimo de 5 segundos entre cada aviso sonoro

// Registra o Service Worker na raiz do GitHub Pages para escutar alertas em background
function registerServiceWorker() {
    if ('serviceWorker' in navigator && 'PushManager' in window) {
        navigator.serviceWorker.register('./sw.js')
            .then(reg => {
                serviceWorkerRegistration = reg;
                console.log('Service Worker nativo registrado com sucesso para escuta local.');
            })
            .catch(err => console.error('Falha crítica ao inicializar Service Worker:', err));
    }
}

// Solicita permissão formal do sistema Android para emitir as caixas de alerta
function requestNotificationPermission() {
    if ('Notification' in window) {
        Notification.requestPermission().then(permission => {
            if (permission === 'granted') {
                console.log('Permissão para alertas nativos confirmada pelo usuário.');
            }
        });
    }
}

function createPulseIcon(color) {
    const userColor = color || localStorage.getItem('syl_marker_color') || '#00ff00';
    return L.divIcon({
        className: 'user-pulse-marker',
        html: `<div style="background-color: ${userColor}; width: 100%; height: 100%; border-radius: 50%; border: 2px solid white; box-shadow: 0 0 5px rgba(0,0,0,0.3);"></div>`,
        iconSize: [10, 10]
    });
}

// Função nativa para gerar alerta sonoro (Bipe eletrônico limpo via Web Audio API)
function playProximityAlertSound() {
    try {
        const AudioContext = window.AudioContext || window.webkitAudioContext;
        if (!AudioContext) return;
        
        const ctx = new AudioContext();
        const oscillator = ctx.createOscillator();
        const gainNode = ctx.createGain();
        
        oscillator.type = 'sine';
        oscillator.frequency.setValueAtTime(880, ctx.currentTime); // Frequência do Alerta (Nota Lá)
        
        // Configuração de envelope suave para evitar cliques de áudio estourados
        gainNode.gain.setValueAtTime(0, ctx.currentTime);
        gainNode.gain.linearRampToValueAtTime(0.3, ctx.currentTime + 0.05);
        gainNode.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.4);
        
        oscillator.connect(gainNode);
        gainNode.connect(ctx.destination);
        
        oscillator.start();
        oscillator.stop(ctx.currentTime + 0.4);
    } catch (e) {
        console.warn("Áudio bloqueado ou não suportado pelo navegador atual:", e);
    }
}

// Encaminha a ordem de renderização visual e vibração para a thread do Service Worker
function sendProximityNotification(username, distance) {
    if (serviceWorkerRegistration && Notification.permission === 'granted') {
        serviceWorkerRegistration.active.postMessage({
            type: 'PROXIMITY_ALERT',
            title: '⚠️ ALERTA DE PROXIMIDADE',
            body: `O usuário "${username}" está operando a apenas ${Math.round(distance)} metros de sua posição!`
        });
    }
}

// Função Matemática de Haversine para calcular distância real em metros entre duas coordenadas geográficas
function calculateDistanceInMeters(lat1, lon1, lat2, lon2) {
    const R = 6371000; // Raio médio da Terra em metros
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = 
        Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c; // Retorna distância convertida em metros
}

// Verifica proximidade de todos os usuários em relação ao usuário local
function checkProximityAlerts(currentLat, currentLng) {
    let closestUser = null;
    let minDistance = Infinity;
    
    for (const clientId in remoteMarkers) {
        if (remoteMarkers[clientId]) {
            const markerLatLng = remoteMarkers[clientId].getLatLng();
            const distance = calculateDistanceInMeters(currentLat, currentLng, markerLatLng.lat, markerLatLng.lng);
            
            // Localiza o usuário mais próximo dentro do raio limite de risco (50 metros)
            if (distance <= 50 && distance < minDistance) {
                minDistance = distance;
                closestUser = clientId;
            }
        }
    }
    
    // Dispara as notificações integradas respeitando o cooldown estipulado de 5 segundos
    if (closestUser) {
        const now = Date.now();
        if (now - lastAlertTime > ALERT_COOLDOWN) {
            playProximityAlertSound(); // Executa o bipe sonoro nativo
            sendProximityNotification(closestUser, minDistance); // Dispara notificação com vibração no celular
            lastAlertTime = now;
        }
    }
}

// Alterna a exibição do painel (Gatilho vindo do menu do smartphone)
function toggleAdminPanel() {
    let adminPanel = document.getElementById('admin-live-panel');
    
    if (adminPanel) {
        if (adminPanel.style.display === 'none') {
            adminPanel.style.display = 'block';
            isMapPanelManuallyClosed = false;
            updateAdminDashboardPanel();
        } else {
            adminPanel.style.display = 'none';
            isMapPanelManuallyClosed = true;
        }
    } else {
        isMapPanelManuallyClosed = false;
        updateAdminDashboardPanel();
    }
}

// Cria ou atualiza em tempo real a listagem do Painel Sutil dentro da Área do Mapa (Disponível para todos)
function updateAdminDashboardPanel() {
    let adminPanel = document.getElementById('admin-live-panel');
    const mapContainer = document.getElementById('map-container');

    // Se o usuário fechou o modal no botão '×', respeita e não força a reabertura automática
    if (isMapPanelManuallyClosed) {
        if (adminPanel) adminPanel.style.display = 'none';
        return;
    }

    // Se o contêiner do mapa não estiver visível ou não existir, não renderiza o painel flutuante ainda
    if (!mapContainer || mapContainer.classList.contains('display-none')) {
        if (adminPanel) adminPanel.style.display = 'none';
        return;
    }

    // Se o painel ainda não existe dentro da área do mapa, cria a estrutura com design fluido e minimalista à esquerda
    if (!adminPanel) {
        adminPanel = document.createElement('div');
        adminPanel.id = 'admin-live-panel';
        adminPanel.style.cssText = `
            position: absolute;
            top: 80px;
            left: 10px;
            width: 280px;
            max-width: calc(100vw - 40px);
            background: rgba(15, 23, 42, 0.85);
            backdrop-filter: blur(8px);
            -webkit-backdrop-filter: blur(8px);
            border: 1px solid rgba(59, 130, 246, 0.3);
            border-radius: 10px;
            padding: 12px;
            color: #f8fafc;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
            box-shadow: 0 4px 15px rgba(0, 0, 0, 0.4);
            z-index: 1001; /* Fica acima das camadas básicas do Leaflet */
            display: block;
        `;
        mapContainer.appendChild(adminPanel);
    } else if (adminPanel.style.display === 'none') {
        adminPanel.style.display = 'block';
    }

    // Mapeia e reúne todos os usuários remotos ativos no mapa
    const userRows = [];
    let activeCounter = 0;

    for (const clientId in remoteMarkers) {
        if (remoteMarkers[clientId]) {
            activeCounter++;
            const latLng = remoteMarkers[clientId].getLatLng();
            userRows.push(`
                <div style="display: flex; justify-content: space-between; align-items: center; padding: 6px 0; border-bottom: 1px solid rgba(255,255,255,0.06); font-size: 12px;">
                    <span style="color: #60a5fa; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 110px;">👤 ${clientId}</span>
                    <span style="color: #94a3b8; font-family: monospace; font-size: 11px;">📍 ${latLng.lat.toFixed(4)}, ${latLng.lng.toFixed(4)}</span>
                </div>
            `);
        }
    }

    // Inclui a si mesmo na contagem total se o marcador pessoal já estiver instanciado
    if (userMarker) {
        activeCounter++;
        const myLatLng = userMarker.getLatLng();
        userRows.unshift(`
            <div style="display: flex; justify-content: space-between; align-items: center; padding: 6px 0; border-bottom: 1px solid rgba(255,255,255,0.06); background: rgba(59, 130, 246, 0.15); border-radius: 4px; padding-left: 4px; padding-right: 4px; font-size: 12px;">
                <span style="color: #34d399; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 110px;">👑 ${currentUsernameString || 'Você'}</span>
                <span style="color: #94a3b8; font-family: monospace; font-size: 11px;">📍 ${myLatLng.lat.toFixed(4)}, ${myLatLng.lng.toFixed(4)}</span>
            </div>
        `);
    }

    // Renderiza o HTML interno dinamicamente adicionando o botão de fechar (×)
    adminPanel.innerHTML = `
        <div style="border-bottom: 1px solid rgba(59, 130, 246, 0.4); padding-bottom: 6px; margin-bottom: 8px; display: flex; justify-content: space-between; align-items: center;">
            <div style="display: flex; flex-direction: column;">
                <span style="margin: 0; color: #3b82f6; font-size: 12px; font-weight: 700; letter-spacing: 0.5px;">MONITORAMENTO</span>
                <span style="color: #a1a1aa; font-size: 10px; font-weight: 500;">Usuários Ativos</span>
            </div>
            <div style="display: flex; align-items: center; gap: 8px;">
                <span style="background: #3b82f6; color: white; padding: 2px 6px; border-radius: 12px; font-size: 10px; font-weight: 700;">
                    ${activeCounter} global
                </span>
                <button id="btn-close-admin-panel" style="background: transparent; border: none; color: #94a3b8; font-size: 18px; cursor: pointer; line-height: 1; padding: 0 2px; transition: color 0.2s;">&times;</button>
            </div>
        </div>
        <div style="max-height: 160px; overflow-y: auto; padding-right: 2px;">
            ${userRows.length > 0 ? userRows.join('') : '<div style="color: #64748b; text-align: center; padding: 10px; font-size: 11px;">Aguardando sinal dos radares...</div>'}
        </div>
    `;

    // Vincula a ação de clique do botão de fechar (×) integrado ao painel flutuante
    const closeBtn = document.getElementById('btn-close-admin-panel');
    if (closeBtn) {
        closeBtn.addEventListener('click', (e) => {
            e.stopPropagation(); // Evita interações indesejadas no mapa ao fundo
            isMapPanelManuallyClosed = true;
            adminPanel.style.display = 'none';
        });
        
        // Efeito hover simples nativo via JS
        closeBtn.addEventListener('mouseenter', () => closeBtn.style.color = '#ef4444');
        closeBtn.addEventListener('mouseleave', () => closeBtn.style.color = '#94a3b8');
    }
}

// Configuração do botão de controle do Painel se o usuário for Admin (Mantido para compatibilidade com o menu)
function setupAdminButtonListener() {
    const adminBtn = document.getElementById('btn-admin-panel');
    if (adminBtn) {
        adminBtn.style.display = 'block'; 
        adminBtn.removeEventListener('click', toggleAdminPanel);
        adminBtn.addEventListener('click', toggleAdminPanel);
    }
}

function initIdentification() {
    const modal = document.getElementById('identification-modal');
    const dashboard = document.getElementById('dashboard-content');
    const input = document.getElementById('user-name-input');
    const btnContinue = document.getElementById('btn-continue');
    const welcomeName = document.getElementById('welcome-username');

    if (!modal || !btnContinue || !input) return;

    // Cria dinamicamente o campo de senha para administradores oculto inicialmente
    let passwordInput = document.getElementById('admin-password-input');
    if (!passwordInput) {
        passwordInput = document.createElement('input');
        passwordInput.id = 'admin-password-input';
        passwordInput.type = 'password';
        passwordInput.placeholder = 'Digite a senha de administrador';
        passwordInput.style.cssText = 'display: none; width: 100%; margin-top: 10px; padding: 12px; border-radius: 6px; background: rgba(0, 0, 0, 0.2); border: 1px solid rgba(255, 255, 255, 0.08); color: white; transition: all 0.3s;';
        
        input.insertAdjacentElement('afterend', passwordInput);
    }

    input.focus();

    function processLogin() {
        const username = input.value.trim();
        if (username === '') {
            input.style.borderColor = '#ef4444';
            input.style.boxShadow = '0 0 15px rgba(239, 68, 68, 0.3)';
            setTimeout(() => {
                input.style.borderColor = 'rgba(255, 255, 255, 0.08)';
                input.style.boxShadow = 'none';
            }, 1000);
            return;
        }

        // Se o usuário digitou alex e o campo de senha ainda não está exposto
        if (username.toLowerCase() === ADMIN_NAME && passwordInput.style.display === 'none') {
            input.style.borderColor = '#3b82f6';
            passwordInput.style.display = 'block';
            passwordInput.focus();
            return;
        }

        // Se o fluxo do Alex está ativo, valida a senha correspondente
        if (username.toLowerCase() === ADMIN_NAME) {
            if (passwordInput.value !== ADMIN_PASSWORD) {
                passwordInput.style.borderColor = '#ef4444';
                passwordInput.style.boxShadow = '0 0 15px rgba(239, 68, 68, 0.3)';
                setTimeout(() => {
                    passwordInput.style.borderColor = 'rgba(255, 255, 255, 0.08)';
                    passwordInput.style.boxShadow = 'none';
                }, 1000);
                return;
            }
            isAdminActive = true;
        }
        
        currentUsernameString = username; 
        
        if (welcomeName) welcomeName.textContent = username;
        modal.style.opacity = '0';
        modal.style.visibility = 'hidden';
        dashboard.classList.remove('dashboard-hidden');
        dashboard.classList.add('dashboard-visible');

        // Solicita autorização de alertas no smartphone assim que o login é efetuado
        requestNotificationPermission();

        // Se for admin, vincula e ativa o botão de gatilho do painel no smartphone
        if (isAdminActive) {
            setupAdminButtonListener();
        }

        try {
            ablyClient = new Ably.Realtime({ key: ABLY_KEY, clientId: currentUsernameString });
            trackingChannel = ablyClient.channels.get('syl-live-map');
        } catch (e) {
            console.error("Falha ao inicializar comunicação Ably:", e);
        }
    }

    btnContinue.addEventListener('click', processLogin);
    input.addEventListener('keypress', (e) => { if (e.key === 'Enter') processLogin(); });
    passwordInput.addEventListener('keypress', (e) => { if (e.key === 'Enter') processLogin(); });
}

function initDigitalClock() {
    const clockElement = document.getElementById('digital-clock');
    if (!clockElement) return;
    function updateClock() {
        const now = new Date();
        clockElement.textContent = now.toTimeString().split(' ')[0];
    }
    updateClock();
    setInterval(updateClock, 1000);
}

function initPlatformAccess() {
    const btnAccess = document.getElementById('btn-access-platform');
    const btnLogout = document.getElementById('btn-menu-logout');
    const presView = document.getElementById('presentation-view');
    const portalView = document.getElementById('portal-view');
    const loadingScreen = document.getElementById('loading-screen');
    const menuScreen = document.getElementById('app-menu-screen');
    const progressBar = document.getElementById('main-progress-bar');
    const progressText = document.getElementById('progress-percentage');
    const menuUserDisplay = document.getElementById('menu-username-display');
    const appHeader = document.querySelector('.app-header');
    const appFooter = document.querySelector('.app-footer');
    const dashboardWrapper = document.getElementById('dashboard-content');
    const mainSectionLayout = document.getElementById('main-section-layout');
    
    const logoutModal = document.getElementById('logout-confirm-modal');
    const btnLogoutYes = document.getElementById('btn-logout-yes');
    const btnLogoutNo = document.getElementById('btn-logout-no');

    if (!btnAccess) return;

    btnAccess.addEventListener('click', () => {
        const currentUsername = document.getElementById('welcome-username')?.textContent || 'Pedestre';
        presView.classList.add('display-none');
        portalView.classList.add('display-none');
        loadingScreen.classList.remove('display-none');
        
        let progress = 0;
        const interval = setInterval(() => {
            progress += 2;
            progressBar.style.width = `${progress}%`;
            progressText.textContent = `${progress}%`;
            if (progress >= 100) {
                clearInterval(interval);
                loadingScreen.classList.add('display-none');
                if (menuUserDisplay) menuUserDisplay.textContent = currentUsername.toUpperCase();
                appHeader?.classList.add('hide-elements');
                appFooter?.classList.add('hide-elements');
                mainSectionLayout?.classList.add('display-none');
                dashboardWrapper?.classList.add('immersive-mode');
                menuScreen.classList.remove('display-none');

                // Garante que o botão do admin seja monitorado se o menu principal for recarregado
                if (isAdminActive) {
                    setupAdminButtonListener();
                }
            }
        }, 30);
    });

    btnLogout?.addEventListener('click', () => { if(logoutModal) logoutModal.classList.remove('display-none'); });
    btnLogoutNo?.addEventListener('click', () => { logoutModal.classList.add('display-none'); });
    
    btnLogoutYes?.addEventListener('click', () => { 
        if (logoutModal) logoutModal.classList.add('display-none');

        if (trackingChannel) {
            trackingChannel.presence.leave();
            trackingChannel.unsubscribe();
        }
        if (ablyClient) ablyClient.close();

        if (watchID) navigator.geolocation.clearWatch(watchID);
        
        for (const id in remoteMarkers) {
            if (remoteMarkers[id]) remoteMarkers[id].remove();
            delete remoteMarkers[id];
        }

        if (map) { map.remove(); map = null; userMarker = null; }
        lastUserLatLng = null;

        // Limpa o painel da árvore de elements na saída do logout completo
        const adminPanel = document.getElementById('admin-live-panel');
        if (adminPanel) adminPanel.remove();
        isAdminActive = false;
        isMapPanelManuallyClosed = false;

        // Oculta o botão de gatilho do admin no logout
        const adminBtn = document.getElementById('btn-admin-panel');
        if (adminBtn) adminBtn.style.display = 'none';

        document.getElementById('map-container')?.classList.add('display-none');
        document.getElementById('map-exit-modal')?.classList.add('display-none');
        document.getElementById('settings-modal')?.classList.add('display-none');
        menuScreen?.classList.add('display-none');

        dashboardWrapper?.classList.remove('immersive-mode');
        appHeader?.classList.remove('hide-elements');
        appFooter?.classList.remove('hide-elements');

        presView?.classList.remove('display-none');
        portalView?.classList.remove('display-none');
        mainSectionLayout?.classList.remove('display-none');

        if (progressBar) progressBar.style.width = '0%';
        if (progressText) progressText.textContent = '0%';

        const modalId = document.getElementById('identification-modal');
        const inputName = document.getElementById('user-name-input');
        const passInput = document.getElementById('admin-password-input');
        if (inputName) inputName.value = '';
        if (passInput) {
            passInput.value = '';
            passInput.style.display = 'none';
        }
        if (modalId) {
            modalId.style.opacity = '1';
            modalId.style.visibility = 'visible';
        }
        
        dashboardWrapper?.classList.remove('dashboard-visible');
        dashboardWrapper?.classList.add('dashboard-hidden');
    });
}

function initMapLoader() {
    const btnMap = document.querySelector('.item-green');
    const mapLoadingScreen = document.getElementById('map-loading-screen');
    const mapContainer = document.getElementById('map-container');
    const progressBar = document.getElementById('map-progress-bar');
    const progressText = document.getElementById('map-progress-percentage');
    const loadingText = document.getElementById('map-loading-text');
    const appHeader = document.querySelector('.app-header');
    const appFooter = document.querySelector('.app-footer');
    const menuScreen = document.getElementById('app-menu-screen');

    const exitModal = document.getElementById('map-exit-modal');
    const btnOpenExit = document.getElementById('btn-open-exit-modal');
    const btnExitYes = document.getElementById('btn-map-exit-yes');
    const btnExitNo = document.getElementById('btn-map-exit-no');

    if (!btnMap || !mapLoadingScreen) return;
    
    if (btnOpenExit) btnOpenExit.style.display = 'none';

    btnMap.addEventListener('click', () => {
        mapLoadingScreen.classList.remove('display-none');
        menuScreen.classList.add('display-none');
        let progress = 0;
        const phases = [
            { p: 20, t: "Sincronizando satélites..." },
            { p: 50, t: "Carregando zonas de risco..." },
            { p: 80, t: "Aplicando filtros de segurança..." },
            { p: 100, t: "Mapa pronto!" }
        ];

        const interval = setInterval(() => {
            progress += 1;
            if (progressBar) progressBar.style.width = `${progress}%`;
            if (progressText) progressText.textContent = `${progress}%`;
            phases.forEach(ph => { if (progress === ph.p && loadingText) loadingText.textContent = ph.t; });

            if (progress >= 100) {
                clearInterval(interval);
                mapLoadingScreen.classList.add('display-none');
                mapContainer?.classList.remove('display-none');
                
                appHeader?.classList.remove('hide-elements');
                appFooter?.classList.remove('hide-elements');
                if (btnOpenExit) btnOpenExit.style.display = 'block';
                
                if (!map) {
                    map = L.map('map-container').setView([-23.5333, -46.3500], 15);
                    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png').addTo(map);

                    // Inicializa e apresenta o painel de conexões logo na abertura primária do mapa
                    isMapPanelManuallyClosed = false;
                    updateAdminDashboardPanel();

                    if (trackingChannel) {
                        trackingChannel.subscribe('location-update', (message) => {
                            if (message.clientId === currentUsernameString) return;

                            const { lat, lng, color } = message.data;
                            
                            if (!remoteMarkers[message.clientId]) {
                                remoteMarkers[message.clientId] = L.marker([lat, lng], { icon: createPulseIcon(color) })
                                    .addTo(map)
                                    .bindPopup(`<b>${message.clientId}</b><br>Ativo no ecossistema`);
                            } else {
                                remoteMarkers[message.clientId].setLatLng([lat, lng]);
                            }

                            if (lastUserLatLng) {
                                checkProximityAlerts(lastUserLatLng.lat, lastUserLatLng.lng);
                            }

                            // Renderiza dinamicamente as alterações de coordenadas para qualquer usuário conectado
                            updateAdminDashboardPanel();
                        });

                        trackingChannel.presence.subscribe('leave', (member) => {
                            if (remoteMarkers[member.clientId]) {
                                remoteMarkers[member.clientId].remove();
                                delete remoteMarkers[member.clientId];
                            }
                            updateAdminDashboardPanel();
                        });

                        trackingChannel.presence.enter();
                    }

                    if (navigator.geolocation) {
                        watchID = navigator.geolocation.watchPosition((pos) => {
                            const latLng = [pos.coords.latitude, pos.coords.longitude];
                            const activeColor = localStorage.getItem('syl_marker_color') || '#00ff00';

                            if (!userMarker) {
                                userMarker = L.marker(latLng, { icon: createPulseIcon() }).addTo(map);
                                map.setView(latLng, 17);
                                lastUserLatLng = { lat: pos.coords.latitude, lng: pos.coords.longitude };
                            } else {
                                userMarker.setLatLng(latLng);
                                
                                const camMoveDelta = calculateDistanceInMeters(
                                    lastUserLatLng.lat, lastUserLatLng.lng, 
                                    pos.coords.latitude, pos.coords.longitude
                                );
                                
                                if (camMoveDelta > 3) {
                                    map.panTo(latLng, { animate: true, duration: 0.8 });
                                    lastUserLatLng = { lat: pos.coords.latitude, lng: pos.coords.longitude };
                                }
                            }

                            checkProximityAlerts(pos.coords.latitude, pos.coords.longitude);
                            updateAdminDashboardPanel();

                            if (trackingChannel) {
                                trackingChannel.publish('location-update', {
                                    lat: pos.coords.latitude,
                                    lng: pos.coords.longitude,
                                    color: activeColor
                                });
                            }

                        }, null, { enableHighAccuracy: true });
                    }
                } else {
                    // Caso o mapa já existisse de instâncias passadas, força a atualização visual do painel
                    isMapPanelManuallyClosed = false;
                    updateAdminDashboardPanel();
                }
            }
        }, 30);
    });

    btnOpenExit?.addEventListener('click', () => exitModal?.classList.remove('display-none'));
    btnExitNo?.addEventListener('click', () => exitModal?.classList.add('display-none'));
    btnExitYes?.addEventListener('click', () => {
        if (trackingChannel) {
            trackingChannel.presence.leave();
            trackingChannel.unsubscribe();
        }

        if (watchID) navigator.geolocation.clearWatch(watchID);
        
        for (const id in remoteMarkers) {
            if (remoteMarkers[id]) remoteMarkers[id].remove();
            delete remoteMarkers[id];
        }

        if (map) { map.remove(); map = null; userMarker = null; }
        lastUserLatLng = null;
        
        // Remove temporariamente o painel da tela ao fechar o mapa para limpar o viewport
        const adminPanel = document.getElementById('admin-live-panel');
        if (adminPanel) adminPanel.remove();
        
        mapContainer?.classList.add('display-none');
        exitModal?.classList.add('display-none');
        menuScreen?.classList.remove('display-none');
        
        appHeader?.classList.add('hide-elements');
        appFooter?.classList.add('hide-elements');
        if (btnOpenExit) btnOpenExit.style.display = 'none';

        if (isAdminActive) {
            setupAdminButtonListener();
        }
    });
}

function initSmartphoneOS() {
    const timeDisplay = document.getElementById('phone-time');
    const updateTime = () => {
        if (!timeDisplay) return;
        timeDisplay.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    };
    setInterval(updateTime, 1000);
    updateTime();
}

function initSettings() {
    const btnSettings = document.querySelector('.item-amber');
    const settingsModal = document.getElementById('settings-modal');
    const btnSave = document.getElementById('btn-save-settings');
    const colorPicker = document.getElementById('marker-color-picker');
    const modeSelect = document.getElementById('alert-mode-select');

    if (btnSave && !document.getElementById('btn-text')) btnSave.innerHTML = '<span id="btn-text">Salvar Alterações</span>';
    const btnText = document.getElementById('btn-text');

    btnSettings?.addEventListener('click', () => {
        colorPicker.value = localStorage.getItem('syl_marker_color') || '#00ff00';
        modeSelect.value = localStorage.getItem('syl_alert_mode') || 'both';
        settingsModal?.classList.remove('display-none');
    });

    btnSave?.addEventListener('click', () => {
        btnSave.disabled = true;
        btnText.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Sincronizando...';
        setTimeout(() => {
            localStorage.setItem('syl_marker_color', colorPicker.value);
            localStorage.setItem('syl_alert_mode', modeSelect.value);
            
            if (userMarker) {
                userMarker.setIcon(createPulseIcon(colorPicker.value));
            }

            btnText.textContent = "✓ Aplicado";
            btnSave.style.backgroundColor = "#10b981";
            setTimeout(() => {
                settingsModal.classList.add('display-none');
                btnSave.disabled = false;
                btnText.textContent = "Salvar Alterações";
                btnSave.style.backgroundColor = "";
            }, 1000);
        }, 1500);
    });
}
