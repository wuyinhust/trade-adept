/**
 * Grandware@once — Service Worker (PWA)
 * 缓存核心静态资源，支持离线访问
 */
const CACHE_NAME = 'grandware-v24';
const STATIC_ASSETS = [
    '/',
    '/index.html',
    '/css/style.css',
    '/js/cloudbase-sdk.js',
    '/js/constants.js',
    '/js/utils.js',
    '/js/cloud.js',
    '/js/auth.js',
    '/js/exchange.js',
    '/js/data.js',
    '/js/app.js',
    '/js/dashboard.js',
    '/js/orders.js',
    '/js/order-import.js',
    '/js/customers.js',
    '/js/factories.js',
    '/js/profit.js',
    '/js/shipping.js',
    '/js/settings.js',
    '/js/tcb.js',
    '/manifest.json'
];

// 安装：预缓存静态资源
self.addEventListener('install', event => {
    event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(STATIC_ASSETS)));
    self.skipWaiting();
});

// 激活：清理旧缓存（包括 v1-v3）
self.addEventListener('activate', event => {
    event.waitUntil(
        caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))))
    );
    self.clients.claim();
});

// ★ 判断是否是 JS/HTML 文件（必须最新，使用 network-first）
function isCodeAsset(url) {
    return url.endsWith('.js') || url.endsWith('.html') || url.endsWith('.json');
}

// 请求拦截：代码文件用 network-first，其他用 cache-first
self.addEventListener('fetch', event => {
    // 跳过 API 请求和 CloudBase 请求
    if (event.request.url.includes('/api/') || event.request.url.includes('tcb-')) {
        return;
    }

    const url = event.request.url;

    if (isCodeAsset(url)) {
        // ★ Network-first：JS/HTML/JSON 必须从网络获取最新版本
        // 如果网络失败才回退到缓存
        event.respondWith(
            fetch(event.request)
                .then(response => {
                    if (response && response.status === 200) {
                        const clone = response.clone();
                        caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
                    }
                    return response;
                })
                .catch(() => {
                    return caches.match(event.request);
                })
        );
    } else {
        // Cache-first：CSS/图片/字体等静态资源优先用缓存
        event.respondWith(
            caches.match(event.request).then(cached => {
                const fetchPromise = fetch(event.request)
                    .then(response => {
                        if (response && response.status === 200) {
                            const clone = response.clone();
                            caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
                        }
                        return response;
                    })
                    .catch(() => cached);

                return cached || fetchPromise;
            })
        );
    }
});
