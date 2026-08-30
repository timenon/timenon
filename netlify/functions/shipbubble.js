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

// Uyo, Akwa Ibom coordinates for high-accuracy validation
const SENDER_PAYLOAD = {
    name:      'Timenon',
    email:     'timenon.official@gmail.com',
    phone:     '+2349014067515',
    address:   '48 Itiam Street, Uyo, Akwa Ibom, Nigeria',
    latitude:   5.0510,
    longitude:  7.9328
};

exports.handler = async function(event) {
    if (event.httpMethod === 'OPTIONS') {
        return { statusCode: 200, headers: CORS, body: '' };
    }
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };
    }

    try {
        const payload = JSON.parse(event.body);
        const { delivery, items, dimension } = payload;

        // Step 1: Check registered addresses for existing sender code
        let senderCode = null;
        const addrListRes = await httpsRequest('GET', SB_HOST, '/v1/shipping/address', AUTH, null);
        console.log('Registered addresses:', JSON.stringify(addrListRes.body));

        if (addrListRes.body?.data && Array.isArray(addrListRes.body.data)) {
            const match = addrListRes.body.data.find(a =>
                (a.email || '').toLowerCase().includes('timenon') ||
                (a.address || '').toLowerCase().includes('itiam') ||
                (a.city || '').toLowerCase().includes('uyo')
            );
            if (match) {
                senderCode = match.address_code || match.id;
                console.log('Found registered sender code:', senderCode);
            }
        }

        // Step 2: Validate sender with lat/lng if no code found
        if (!senderCode) {
            console.log('Validating sender address with coordinates...');
            const senderRes = await httpsRequest('POST', SB_HOST, '/v1/shipping/address/validate', AUTH, SENDER_PAYLOAD);
            console.log('Sender validation:', JSON.stringify(senderRes.body));

            if (senderRes.body?.data?.address_code) {
                senderCode = senderRes.body.data.address_code;
                console.log('Got sender code:', senderCode);
            } else {
                return {
                    statusCode: 200, headers: CORS,
                    body: JSON.stringify({
                        status: 'error',
                        message: 'Sender address validation failed',
                        detail: senderRes.body
                    })
                };
            }
        }

        // Step 3: Validate receiver address
        console.log('Validating receiver:', JSON.stringify(delivery));
        const receiverRes = await httpsRequest('POST', SB_HOST, '/v1/shipping/address/validate', AUTH, {
            name:    delivery.name  || 'Customer',
            email:   delivery.email || 'customer@timenon.com',
            phone:   delivery.phone || '08000000000',
            address: delivery.address
        });
        console.log('Receiver validation:', JSON.stringify(receiverRes.body));

        if (!receiverRes.body?.data?.address_code) {
            return {
                statusCode: 200, headers: CORS,
                body: JSON.stringify({
                    status: 'error',
                    message: 'Could not validate delivery address. Try entering a more detailed address.',
                    detail: receiverRes.body
                })
            };
        }
        const receiverCode = receiverRes.body.data.address_code;

        // Step 4: Get clothing category ID
        const catsRes = await httpsRequest('GET', SB_HOST, '/v1/shipping/package/categories', AUTH, null);
        let categoryId = 4;
        if (catsRes.body?.data && Array.isArray(catsRes.body.data)) {
            console.log('Available categories:', catsRes.body.data.map(c => `${c.id}:${c.name}`).join(', '));
            const cat = catsRes.body.data.find(c => /cloth|fashion|apparel|wear/i.test(c.name || ''));
            if (cat) categoryId = cat.id;
        }

        // Step 5: Pickup date (tomorrow if after 5PM WAT)
        const now = new Date();
        if ((now.getUTCHours() + 1) % 24 >= 17) now.setDate(now.getDate() + 1);
        const pickupDate = now.toISOString().split('T')[0];

        // Step 6: Fetch shipping rates
        const ratesPayload = {
            sender_address_code:   senderCode,
            reciever_address_code: receiverCode,
            pickup_date:           pickupDate,
            category_id:           categoryId,
            package_items:         items,
            package_dimension:     dimension || { length: 35, width: 30, height: 10 }
        };
        console.log('Fetching rates:', JSON.stringify(ratesPayload));
        const ratesRes = await httpsRequest('POST', SB_HOST, '/v1/shipping/fetch_rates', AUTH, ratesPayload);
        console.log('Rates response:', JSON.stringify(ratesRes.body));

        return { statusCode: 200, headers: CORS, body: JSON.stringify(ratesRes.body) };

    } catch (err) {
        console.error('Error:', err.message);
        return {
            statusCode: 500, headers: CORS,
            body: JSON.stringify({ status: 'error', message: err.message })
        };
    }
};
