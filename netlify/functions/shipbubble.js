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
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };
    }

    try {
        const payload = JSON.parse(event.body);
        const { delivery, items, dimension } = payload;

        console.log('Delivery address:', JSON.stringify(delivery));

        // Step 1: Get existing registered addresses to find sender code
        const addressListRes = await httpsRequest('GET', SB_HOST, '/v1/shipping/address', AUTH, null);
        console.log('Address list response:', JSON.stringify(addressListRes.body));

        let senderCode = null;

        if (addressListRes.body && addressListRes.body.data && Array.isArray(addressListRes.body.data)) {
            // Find the Uyo/Timenon address
            const sender = addressListRes.body.data.find(a =>
                (a.address || '').toLowerCase().includes('itiam') ||
                (a.city || '').toLowerCase().includes('uyo') ||
                (a.name || '').toLowerCase().includes('timenon') ||
                (a.email || '').toLowerCase().includes('timenon')
            );
            if (sender) {
                senderCode = sender.address_code || sender.id;
                console.log('Found sender address code:', senderCode, 'for:', sender.address);
            } else {
                // Log all addresses so we can see what's there
                console.log('All registered addresses:', addressListRes.body.data.map(a =>
                    `code:${a.address_code || a.id} name:${a.name} city:${a.city} addr:${a.address}`
                ).join(' | '));
            }
        }

        // Step 2: If no sender code found, validate the address fresh
        if (!senderCode) {
            console.log('Sender not found in list, validating fresh...');
            const senderValidate = await httpsRequest('POST', SB_HOST, '/v1/shipping/address/validate', AUTH, {
                name:    'Timenon',
                email:   'timenon.official@gmail.com',
                phone:   '+2349014067515',
                address: '48 Itiam Street, Uyo, Akwa Ibom, Nigeria'
            });
            console.log('Sender validate result:', JSON.stringify(senderValidate.body));

            if (senderValidate.body && senderValidate.body.data && senderValidate.body.data.address_code) {
                senderCode = senderValidate.body.data.address_code;
                console.log('Got fresh sender code:', senderCode);
            } else {
                return {
                    statusCode: 200, headers: CORS,
                    body: JSON.stringify({
                        status: 'error',
                        message: 'Sender address validation failed. Please contact support.',
                        detail: senderValidate.body
                    })
                };
            }
        }

        // Step 3: Validate receiver address
        const receiverValidate = await httpsRequest('POST', SB_HOST, '/v1/shipping/address/validate', AUTH, {
            name:    delivery.name  || 'Customer',
            email:   delivery.email || 'customer@timenon.com',
            phone:   delivery.phone || '08000000000',
            address: delivery.address
        });
        console.log('Receiver validate result:', JSON.stringify(receiverValidate.body));

        let receiverCode = null;
        if (receiverValidate.body && receiverValidate.body.data && receiverValidate.body.data.address_code) {
            receiverCode = receiverValidate.body.data.address_code;
        } else {
            return {
                statusCode: 200, headers: CORS,
                body: JSON.stringify({
                    status: 'error',
                    message: 'Could not validate delivery address. Please check your address details.',
                    detail: receiverValidate.body
                })
            };
        }

        // Step 4: Get categories
        const catsRes = await httpsRequest('GET', SB_HOST, '/v1/shipping/package/categories', AUTH, null);
        let categoryId = 4;
        if (catsRes.body && catsRes.body.data && Array.isArray(catsRes.body.data)) {
            console.log('Categories:', catsRes.body.data.map(c => `${c.id}:${c.name}`).join(', '));
            const clothing = catsRes.body.data.find(c =>
                /cloth|fashion|apparel|wear|textile/i.test(c.name || '')
            );
            if (clothing) { categoryId = clothing.id; console.log('Using category:', clothing.name, categoryId); }
        }

        // Step 5: Pickup date
        const now = new Date();
        const watHour = (now.getUTCHours() + 1) % 24;
        if (watHour >= 17) now.setDate(now.getDate() + 1);
        const pickupDate = now.toISOString().split('T')[0];

        // Step 6: Fetch rates
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
