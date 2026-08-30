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
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json'
};

const API_KEY = 'sb_prod_90b8d67fc0c70382a6f5b63de7dcf9b1497a30118f7e930085086ebc80572fa2';
const SB_HOST = 'api.shipbubble.com';
const AUTH    = { 'Authorization': `Bearer ${API_KEY}`, 'Content-Type': 'application/json' };

exports.handler = async function(event) {
    if (event.httpMethod === 'OPTIONS') {
        return { statusCode: 200, headers: CORS, body: '' };
    }

    // Special endpoint: just get sender address code (call once to set up)
    if (event.httpMethod === 'GET') {
        const res = await httpsRequest('GET', SB_HOST, '/v1/shipping/address', AUTH, null);
        return { statusCode: 200, headers: CORS, body: JSON.stringify(res.body) };
    }

    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };
    }

    try {
        const payload = JSON.parse(event.body);
        const { delivery, items, dimension } = payload;

        // ── STEP 1: Get sender address code from registered addresses ──
        const addrRes = await httpsRequest('GET', SB_HOST, '/v1/shipping/address', AUTH, null);
        console.log('GET /shipping/address status:', addrRes.status);
        console.log('GET /shipping/address body:', JSON.stringify(addrRes.body));

        let senderCode = null;

        if (addrRes.body?.data?.results && Array.isArray(addrRes.body.data.results)) {
            // Look through all registered addresses for Timenon/Uyo
            for (const a of addrRes.body.data.results) {
                const addr = a.address_data || a;
                const combined = JSON.stringify(addr).toLowerCase();
                if (combined.includes('timenon') || combined.includes('uyo') || combined.includes('itiam')) {
                    senderCode = a.address_code;
                    console.log('Found sender code:', senderCode, JSON.stringify(addr));
                    break;
                }
            }
            if (!senderCode) {
                // Log all so we can see what's registered
                console.log('All addresses:', addrRes.body.data.results.map(a =>
                    `code:${a.address_code} data:${JSON.stringify(a.address_data)}`
                ).join(' || '));
            }
        }

        // ── STEP 2: Validate sender if not found ──
        if (!senderCode) {
            console.log('No registered sender found, validating with coordinates...');
            const svRes = await httpsRequest('POST', SB_HOST, '/v1/shipping/address/validate', AUTH, {
                name:      'Timenon',
                email:     'timenon.official@gmail.com',
                phone:     '+2349014067515',
                address:   'Uyo, Akwa Ibom, Nigeria',
                latitude:   5.0510,
                longitude:  7.9328
            });
            console.log('Sender validate status:', svRes.status, 'body:', JSON.stringify(svRes.body));

            if (svRes.body?.data?.address_code) {
                senderCode = svRes.body.data.address_code;
            } else {
                return {
                    statusCode: 200, headers: CORS,
                    body: JSON.stringify({
                        status: 'error',
                        message: 'Sender validation failed: ' + JSON.stringify(svRes.body)
                    })
                };
            }
        }

        // ── STEP 3: Validate receiver address ──
        const rvRes = await httpsRequest('POST', SB_HOST, '/v1/shipping/address/validate', AUTH, {
            name:    delivery.name  || 'Customer',
            email:   delivery.email || 'customer@timenon.com',
            phone:   delivery.phone || '08000000000',
            address: delivery.address
        });
        console.log('Receiver validate status:', rvRes.status, 'body:', JSON.stringify(rvRes.body));

        if (!rvRes.body?.data?.address_code) {
            return {
                statusCode: 200, headers: CORS,
                body: JSON.stringify({
                    status: 'error',
                    message: 'Delivery address could not be verified. Please enter a more detailed address (include street, city, state).',
                    detail: rvRes.body
                })
            };
        }
        const receiverCode = rvRes.body.data.address_code;

        // ── STEP 4: Get category ──
        const catsRes = await httpsRequest('GET', SB_HOST, '/v1/shipping/package/categories', AUTH, null);
        let categoryId = 4;
        if (catsRes.body?.data && Array.isArray(catsRes.body.data)) {
            console.log('Categories:', catsRes.body.data.map(c => `${c.id}:${c.name}`).join(', '));
            const cat = catsRes.body.data.find(c => /cloth|fashion|apparel|wear/i.test(c.name || ''));
            if (cat) { categoryId = cat.id; console.log('Using category:', cat.name, cat.id); }
        }

        // ── STEP 5: Pickup date ──
        const now = new Date();
        if ((now.getUTCHours() + 1) % 24 >= 17) now.setDate(now.getDate() + 1);
        const pickupDate = now.toISOString().split('T')[0];
        console.log('Pickup date:', pickupDate, '| Sender code:', senderCode, '| Receiver code:', receiverCode);

        // ── STEP 6: Fetch rates ──
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
        console.log('Rates response status:', ratesRes.status);
        console.log('Rates response:', JSON.stringify(ratesRes.body));

        return { statusCode: 200, headers: CORS, body: JSON.stringify(ratesRes.body) };

    } catch (err) {
        console.error('Function error:', err.message, err.stack);
        return {
            statusCode: 500, headers: CORS,
            body: JSON.stringify({ status: 'error', message: err.message })
        };
    }
};
