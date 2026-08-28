const https = require('https');

function httpsRequest(method, hostname, path, headers, body) {
    return new Promise((resolve, reject) => {
        const data = body ? JSON.stringify(body) : null;
        const options = {
            hostname, path, method,
            headers: {
                ...headers,
                ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {})
            }
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
const AUTH    = {
    'Authorization': `Bearer ${API_KEY}`,
    'Content-Type': 'application/json'
};

async function validateAddress(addressObj) {
    // Correct Shipbubble endpoint: POST /v1/shipping/address/validate
    const res = await httpsRequest('POST', SB_HOST, '/v1/shipping/address/validate', AUTH, addressObj);
    console.log('Address validate response:', JSON.stringify(res.body));
    return res.body;
}

async function getPackageCategories() {
    const res = await httpsRequest('GET', SB_HOST, '/v1/shipping/package/categories', AUTH, null);
    console.log('Categories:', JSON.stringify(res.body));
    return res.body;
}

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

        console.log('Incoming payload:', JSON.stringify(payload));

        // Step 1: Validate sender address
        const senderRes = await validateAddress({
            name:    'Timenon',
            email:   'timenontheconfidencebrand@gmail.com',
            phone:   '09014067515',
            address: '48 Itiam Street, Uyo, Akwa Ibom, Nigeria'
        });

        if (!senderRes.data || !senderRes.data.address_code) {
            console.error('Sender validation failed:', JSON.stringify(senderRes));
            return {
                statusCode: 200, headers: CORS,
                body: JSON.stringify({
                    status: 'error',
                    message: 'Sender address could not be validated',
                    detail: senderRes
                })
            };
        }
        const senderCode = senderRes.data.address_code;
        console.log('Sender address code:', senderCode);

        // Step 2: Validate receiver address
        const receiverRes = await validateAddress({
            name:    delivery.name    || 'Customer',
            email:   delivery.email   || 'customer@timenon.com',
            phone:   delivery.phone   || '08000000000',
            address: delivery.address
        });

        if (!receiverRes.data || !receiverRes.data.address_code) {
            console.error('Receiver validation failed:', JSON.stringify(receiverRes));
            return {
                statusCode: 200, headers: CORS,
                body: JSON.stringify({
                    status: 'error',
                    message: 'Delivery address could not be validated. Please check the address and try again.',
                    detail: receiverRes
                })
            };
        }
        const receiverCode = receiverRes.data.address_code;
        console.log('Receiver address code:', receiverCode);

        // Step 3: Get category ID for clothing
        const categoriesRes = await getPackageCategories();
        let categoryId = 4; // default fallback
        if (categoriesRes.data && Array.isArray(categoriesRes.data)) {
            const clothing = categoriesRes.data.find(c =>
                (c.name || '').toLowerCase().includes('cloth') ||
                (c.name || '').toLowerCase().includes('fashion') ||
                (c.name || '').toLowerCase().includes('apparel') ||
                (c.name || '').toLowerCase().includes('wear')
            );
            if (clothing) {
                categoryId = clothing.id;
                console.log('Found clothing category:', clothing.name, 'ID:', categoryId);
            } else {
                console.log('No clothing category found, using ID:', categoryId);
                console.log('Available categories:', categoriesRes.data.map(c => `${c.id}: ${c.name}`).join(', '));
            }
        }

        // Step 4: Pickup date (tomorrow if after 5PM WAT)
        const now = new Date();
        const watHour = (now.getUTCHours() + 1) % 24;
        if (watHour >= 17) now.setDate(now.getDate() + 1);
        const pickupDate = now.toISOString().split('T')[0];
        console.log('Pickup date:', pickupDate);

        // Step 5: Fetch rates
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

        return {
            statusCode: 200, headers: CORS,
            body: JSON.stringify(ratesRes.body)
        };

    } catch (err) {
        console.error('Function error:', err.message, err.stack);
        return {
            statusCode: 500, headers: CORS,
            body: JSON.stringify({ status: 'error', message: err.message })
        };
    }
};
