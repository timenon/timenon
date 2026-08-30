const https = require('https');

function httpsRequest(method, hostname, path, headers, body) {
    return new Promise((resolve, reject) => {
        const data = body ? JSON.stringify(body) : null;
        const options = {
            hostname, path, method,
            headers: { ...headers, ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}) }
        };
        const req = https.request(options, res => {
            let raw = '';
            res.on('data', c => raw += c);
            res.on('end', () => {
                try { resolve({ status: res.statusCode, body: JSON.parse(raw) }); }
                catch(e) { resolve({ status: res.statusCode, body: raw }); }
            });
        });
        req.on('error', reject);
        if (data) req.write(data);
        req.end();
    });
}

const CORS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Content-Type': 'application/json'
};

const API_KEY = 'sb_prod_90b8d67fc0c70382a6f5b63de7dcf9b1497a30118f7e930085086ebc80572fa2';
const SB_HOST = 'api.shipbubble.com';
const AUTH    = { 'Authorization': `Bearer ${API_KEY}`, 'Content-Type': 'application/json' };

// Uyo city centre coordinates (more general — avoids street-level lookup issues)
const SENDER_ADDRESSES_TO_TRY = [
    // Try with coordinates only (most reliable per Shipbubble docs)
    { name: 'Timenon', email: 'timenon.official@gmail.com', phone: '+2349014067515',
      address: 'Uyo, Akwa Ibom, Nigeria', latitude: 5.0510, longitude: 7.9328 },
    // Try state capital without street
    { name: 'Timenon', email: 'timenon.official@gmail.com', phone: '+2349014067515',
      address: 'Uyo, Akwa Ibom State, Nigeria', latitude: 5.0510, longitude: 7.9328 },
    // Try nearby landmark
    { name: 'Timenon', email: 'timenon.official@gmail.com', phone: '+2349014067515',
      address: 'Uyo, Nigeria', latitude: 5.0510, longitude: 7.9328 },
];

async function validateSender() {
    for (const attempt of SENDER_ADDRESSES_TO_TRY) {
        console.log('Trying sender:', JSON.stringify(attempt));
        const res = await httpsRequest('POST', SB_HOST, '/v1/shipping/address/validate', AUTH, attempt);
        console.log('Result status:', res.status, 'body:', JSON.stringify(res.body));
        if (res.body?.data?.address_code) {
            return res.body.data.address_code;
        }
    }
    return null;
}

exports.handler = async function(event) {
    if (event.httpMethod === 'OPTIONS') {
        return { statusCode: 200, headers: CORS, body: '' };
    }

    // GET: return registered addresses + try validating sender
    if (event.httpMethod === 'GET') {
        const addrRes = await httpsRequest('GET', SB_HOST, '/v1/shipping/address', AUTH, null);
        const senderCode = await validateSender();
        return {
            statusCode: 200, headers: CORS,
            body: JSON.stringify({
                registered_addresses: addrRes.body,
                sender_validation_result: senderCode,
            })
        };
    }

    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };
    }

    try {
        const payload = JSON.parse(event.body);
        const { delivery, items, dimension } = payload;

        // ── STEP 1: Get sender code ──
        const senderCode = await validateSender();
        if (!senderCode) {
            // Uyo not in Shipbubble coverage — use flat rate fallback
            return {
                statusCode: 200, headers: CORS,
                body: JSON.stringify({
                    status: 'no_coverage',
                    message: 'Uyo is not yet fully covered by Shipbubble. Using standard flat rate.',
                })
            };
        }
        console.log('Sender code:', senderCode);

        // ── STEP 2: Validate receiver ──
        const rvRes = await httpsRequest('POST', SB_HOST, '/v1/shipping/address/validate', AUTH, {
            name:    delivery.name  || 'Customer',
            email:   delivery.email || 'customer@timenon.com',
            phone:   delivery.phone || '08000000000',
            address: delivery.address
        });
        console.log('Receiver:', JSON.stringify(rvRes.body));

        if (!rvRes.body?.data?.address_code) {
            return {
                statusCode: 200, headers: CORS,
                body: JSON.stringify({
                    status: 'error',
                    message: 'Could not verify delivery address. Please include street, city and state.',
                    detail: rvRes.body
                })
            };
        }
        const receiverCode = rvRes.body.data.address_code;

        // ── STEP 3: Category ──
        const catsRes = await httpsRequest('GET', SB_HOST, '/v1/shipping/package/categories', AUTH, null);
        let categoryId = 4;
        if (catsRes.body?.data && Array.isArray(catsRes.body.data)) {
            const cat = catsRes.body.data.find(c => /cloth|fashion|apparel|wear/i.test(c.name || ''));
            if (cat) categoryId = cat.id;
            console.log('Category:', categoryId, catsRes.body.data.map(c=>`${c.id}:${c.name}`).join(','));
        }

        // ── STEP 4: Pickup date ──
        const now = new Date();
        if ((now.getUTCHours() + 1) % 24 >= 17) now.setDate(now.getDate() + 1);
        const pickupDate = now.toISOString().split('T')[0];

        // ── STEP 5: Fetch rates ──
        const ratesPayload = {
            sender_address_code:   senderCode,
            reciever_address_code: receiverCode,
            pickup_date:           pickupDate,
            category_id:           categoryId,
            package_items:         items,
            package_dimension:     dimension || { length: 35, width: 30, height: 10 }
        };
        console.log('Rates payload:', JSON.stringify(ratesPayload));
        const ratesRes = await httpsRequest('POST', SB_HOST, '/v1/shipping/fetch_rates', AUTH, ratesPayload);
        console.log('Rates:', JSON.stringify(ratesRes.body));

        return { statusCode: 200, headers: CORS, body: JSON.stringify(ratesRes.body) };

    } catch (err) {
        console.error('Error:', err.message);
        return {
            statusCode: 500, headers: CORS,
            body: JSON.stringify({ status: 'error', message: err.message })
        };
    }
};
