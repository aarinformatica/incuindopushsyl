// sw.js - Service Worker Nativo para Escuta em Background

// Intercepta e processa ordens de notificações locais vindas do script principal
self.addEventListener('message', function(event) {
    if (event.data && event.data.type === 'PROXIMITY_ALERT') {
        const options = {
            body: event.data.body,
            icon: 'icon.png', // Forneça um ícone válido na raiz se desejar uma imagem customizada
            badge: 'icon.png', // Ícone minúsculo para a barra superior do Android
            vibrate: [300, 110, 300], // Padrão de vibração alternada (Forte, Curto, Forte)
            tag: 'alerta-proximidade', // Substitui a notificação anterior em vez de empilhar dezenas delas
            renotify: true, // Garante que o smartphone vibre e acenda a tela a cada nova leitura
            data: {
                url: self.location.origin + self.location.pathname
            }
        };

        event.waitUntil(
            self.registration.showNotification(event.data.title, options)
        );
    }
});

// Manipula o clique do usuário sobre a barra de notificação
self.addEventListener('notificationclick', function(event) {
    event.notification.close(); // Fecha o card visual do topo
    
    // Varre as abas abertas para focar no mapa ativo ou abrir uma nova janela do app
    event.waitUntil(
        clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function(clientList) {
            for (var i = 0; i < clientList.length; i++) {
                var client = clientList[i];
                if ('focus' in client) return client.focus();
            }
            if (clients.openWindow) return clients.openWindow(event.notification.data.url);
        })
    );
});
