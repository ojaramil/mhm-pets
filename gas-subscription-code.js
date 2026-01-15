/**
 * ===========================================
 * MHM PETS - Google Apps Script Backend
 * Maneja: Suscripciones + PayPal Webhooks + Cloud Storage
 * ===========================================
 * 
 * INSTRUCCIONES DE INSTALACIÓN:
 * 
 * 1. Ve a https://script.google.com/create
 * 2. Copia todo este código y pégalo
 * 3. Crea un nuevo Google Sheet con 3 hojas:
 *    - "Subscribers" (para suscriptores)
 *    - "PetData" (para datos de mascotas)
 *    - "Logs" (para logs de PayPal)
 * 4. Copia el ID del Sheet de la URL (entre /d/ y /edit)
 * 5. Pega el ID en SHEET_ID más abajo
 * 6. Deploy > New deployment > Web app
 *    - Execute as: Me
 *    - Who has access: Anyone
 * 7. Copia la URL del deployment y úsala en la app
 * 
 * Para PayPal Webhooks:
 * 1. Ve a developer.paypal.com
 * 2. Crea una app en My Apps & Credentials
 * 3. Ve a Webhooks > Add Webhook
 * 4. Pega la URL del deployment
 * 5. Selecciona los eventos de BILLING y PAYMENT
 */

// ==========================================
// CONFIGURACIÓN - EDITAR ESTOS VALORES
// ==========================================

const SHEET_ID = '1_jNNbqh6HVHLjqDJkwiS2en9_hAVfq1q_yJmTFUz124'; // El ID de tu Google Sheet

// Planes de suscripción
const SUBSCRIPTION_PLANS = {
    free: { name: 'Gratis', maxPets: 1, price: 0 },
    basic: { name: 'Básico', maxPets: 3, price: 24 },
    pro: { name: 'Pro', maxPets: 5, price: 36 },
    premium: { name: 'Premium', maxPets: 10, price: 48 }
};

// IDs de planes de PayPal (configura estos después de crear los planes en PayPal)
const PAYPAL_PLAN_IDS = {
    'P-BASIC-PLAN-ID': 'basic',
    'P-PRO-PLAN-ID': 'pro',
    'P-PREMIUM-PLAN-ID': 'premium'
};

// ==========================================
// FUNCIONES PRINCIPALES
// ==========================================

/**
 * Maneja solicitudes GET (lectura de datos)
 */
function doGet(e) {
    // Validación para ejecución manual desde el editor
    if (!e || !e.parameter) {
        return createResponse({ status: 'error', message: 'Esta función debe ser llamada vía HTTP, no manualmente' });
    }

    const action = e.parameter.action || 'read';
    const id = e.parameter.id;

    try {
        switch (action) {
            case 'read':
                return handleRead(id);
            // ⚠️ SAVE VIA GET - Alternativa para evitar problemas de CORS con POST
            case 'save':
            case 'saveData':
                // Datos vienen codificados en base64 para evitar problemas con caracteres especiales
                const encodedData = e.parameter.data;
                if (encodedData) {
                    try {
                        const decodedData = Utilities.newBlob(Utilities.base64Decode(encodedData)).getDataAsString();
                        const petData = JSON.parse(decodedData);
                        return handleSave(id, petData);
                    } catch (decodeError) {
                        // Intenta como JSON directo (para datos pequeños)
                        try {
                            const petData = JSON.parse(decodeURIComponent(encodedData));
                            return handleSave(id, petData);
                        } catch (e2) {
                            return createResponse({ status: 'error', message: 'Error decodificando datos: ' + decodeError.message });
                        }
                    }
                }
                return createResponse({ status: 'error', message: 'Data required' });
            case 'checkSubscription':
                return handleCheckSubscription(e.parameter.email, e.parameter.cloudId);
            case 'getSubscribers':
                return handleGetSubscribers();
            case 'getAccountByEmail':
                return handleGetAccountByEmail(e.parameter.email);
            case 'getAccountByCloudId':
                return handleGetAccountByCloudId(e.parameter.cloudId);
            // Email verification actions (via GET to avoid CORS)
            case 'sendVerificationCode':
                return handleSendVerificationCode(e.parameter.email, e.parameter.cloudId);
            case 'verifyCode':
                return handleVerifyCode(e.parameter.email, e.parameter.code, e.parameter.cloudId);
            case 'recoverAccount':
                return handleRecoverAccount(e.parameter.email);
            // Admin actions (via GET to avoid CORS)
            case 'registerSubscription':
                return handleRegisterSubscriptionGET(e.parameter);
            default:
                return createResponse({ status: 'error', message: 'Action not found' });
        }
    } catch (error) {
        logError('doGet', error);
        return createResponse({ status: 'error', message: error.message });
    }
}

/**
 * Maneja solicitudes POST (escritura de datos)
 */
function doPost(e) {
    try {
        let data;

        // Parse the request body
        if (e.postData && e.postData.contents) {
            data = JSON.parse(e.postData.contents);
        } else {
            return createResponse({ status: 'error', message: 'No data received' });
        }

        const action = data.action || 'save';

        switch (action) {
            case 'save':
                return handleSave(data.id, data.data);
            case 'uploadImage':
                return handleUploadImage(data.image);
            case 'paypalWebhook':
                return handlePayPalWebhook(data);
            case 'adminSync':
                return handleAdminSync(data.subscribers);
            case 'registerSubscription':
                return handleRegisterSubscription(data);
            // Email Verification & Account Linking
            case 'sendVerificationCode':
                return handleSendVerificationCode(data.email, data.cloudId);
            case 'verifyCode':
                return handleVerifyCode(data.email, data.code, data.cloudId);
            case 'linkEmail':
                return handleLinkEmail(data.email, data.cloudId);
            case 'recoverAccount':
                return handleRecoverAccount(data.email);
            default:
                // For PayPal IPN - legacy support
                if (e.postData.type === 'application/x-www-form-urlencoded') {
                    return handlePayPalIPN(e);
                }
                return handleSave(data.id, data.data);
        }
    } catch (error) {
        logError('doPost', error);
        return createResponse({ status: 'error', message: error.message });
    }
}

// ==========================================
// SUSCRIPCIONES
// ==========================================

/**
 * Verifica el estado de suscripción de un usuario
 */
function handleCheckSubscription(email, cloudId) {
    const sheet = getSheet('Subscribers');
    const data = sheet.getDataRange().getValues();

    // Find subscriber by email or cloudId
    for (let i = 1; i < data.length; i++) {
        const row = data[i];
        const subEmail = row[0];
        const subCloudId = row[1];
        const plan = row[2];
        const expiresAt = row[4];
        const status = row[5];

        if ((email && subEmail === email) || (cloudId && subCloudId === cloudId)) {
            const now = new Date();
            const expiry = new Date(expiresAt);
            const isActive = status === 'active' && expiry > now;

            const planInfo = SUBSCRIPTION_PLANS[plan] || SUBSCRIPTION_PLANS.free;

            return createResponse({
                status: 'success',
                subscription: {
                    plan: plan,
                    maxPets: planInfo.maxPets,
                    isActive: isActive,
                    expiresAt: expiresAt,
                    email: subEmail,
                    cloudId: subCloudId
                }
            });
        }
    }

    // No subscription found - return free plan
    return createResponse({
        status: 'success',
        subscription: {
            plan: 'free',
            maxPets: 1,
            isActive: true,
            expiresAt: null,
            email: email || null,
            cloudId: cloudId || null
        }
    });
}

/**
 * Registra una nueva suscripción manualmente
 */
function handleRegisterSubscription(data) {
    const sheet = getSheet('Subscribers');
    const now = new Date();
    const expiresAt = new Date(now);
    expiresAt.setFullYear(expiresAt.getFullYear() + 1);

    const cloudId = data.cloudId || ('MHM-' + generateRandomString(4));

    // Check if subscriber already exists
    const existingRow = findSubscriberRow(sheet, data.email, cloudId);

    if (existingRow > 0) {
        // Update existing subscription
        sheet.getRange(existingRow, 3).setValue(data.plan); // Plan
        sheet.getRange(existingRow, 5).setValue(expiresAt.toISOString()); // Expires
        sheet.getRange(existingRow, 6).setValue('active'); // Status
        sheet.getRange(existingRow, 7).setValue(data.txnId || ''); // Transaction ID
        sheet.getRange(existingRow, 8).setValue(now.toISOString()); // Updated At
    } else {
        // Create new subscription
        sheet.appendRow([
            data.email,
            cloudId,
            data.plan || 'basic',
            now.toISOString(), // Created At
            expiresAt.toISOString(), // Expires At
            'active',
            data.txnId || '',
            now.toISOString()
        ]);
    }

    return createResponse({
        status: 'success',
        message: 'Subscription registered',
        cloudId: cloudId,
        expiresAt: expiresAt.toISOString()
    });
}

/**
 * Registra suscripción via GET (para evitar CORS desde admin)
 */
function handleRegisterSubscriptionGET(params) {
    const data = {
        email: params.email,
        cloudId: params.cloudId,
        plan: params.plan || 'free',
        txnId: params.txnId || '',
        status: params.status || 'active'
    };

    return handleRegisterSubscription(data);
}

/**
 * Sincroniza suscriptores desde el panel admin
 */
function handleAdminSync(subscribers) {
    if (!subscribers || !Array.isArray(subscribers)) {
        return createResponse({ status: 'error', message: 'Invalid subscribers data' });
    }

    const sheet = getSheet('Subscribers');

    // Clear existing data (except header)
    const lastRow = sheet.getLastRow();
    if (lastRow > 1) {
        sheet.getRange(2, 1, lastRow - 1, 8).clearContent();
    }

    // Add all subscribers
    subscribers.forEach(sub => {
        sheet.appendRow([
            sub.email || '',
            sub.cloudId || '',
            sub.plan || 'free',
            sub.createdAt || new Date().toISOString(),
            sub.expiresAt || '',
            sub.status || 'active',
            sub.txnId || '',
            sub.updatedAt || new Date().toISOString()
        ]);
    });

    return createResponse({
        status: 'success',
        message: `Synced ${subscribers.length} subscribers`
    });
}

/**
 * Obtiene todos los suscriptores
 */
function handleGetSubscribers() {
    const sheet = getSheet('Subscribers');
    const data = sheet.getDataRange().getValues();

    const subscribers = [];
    for (let i = 1; i < data.length; i++) {
        const row = data[i];
        if (row[0]) { // Has email
            subscribers.push({
                email: row[0],
                cloudId: row[1],
                plan: row[2],
                createdAt: row[3],
                expiresAt: row[4],
                status: row[5],
                txnId: row[6],
                updatedAt: row[7]
            });
        }
    }

    return createResponse({
        status: 'success',
        subscribers: subscribers
    });
}

// ==========================================
// PAYPAL WEBHOOK HANDLER
// ==========================================

/**
 * Procesa webhooks de PayPal
 */
function handlePayPalWebhook(data) {
    const eventType = data.event_type;
    const resource = data.resource;

    // Log the webhook event
    logPayPalEvent(eventType, data);

    switch (eventType) {
        case 'BILLING.SUBSCRIPTION.ACTIVATED':
        case 'BILLING.SUBSCRIPTION.CREATED':
            return processSubscriptionActivated(resource);

        case 'BILLING.SUBSCRIPTION.CANCELLED':
        case 'BILLING.SUBSCRIPTION.EXPIRED':
        case 'BILLING.SUBSCRIPTION.SUSPENDED':
            return processSubscriptionEnded(resource);

        case 'PAYMENT.SALE.COMPLETED':
            return processPaymentCompleted(resource);

        default:
            return createResponse({ status: 'ok', message: 'Event logged' });
    }
}

/**
 * Procesa IPN de PayPal (legacy)
 */
function handlePayPalIPN(e) {
    const params = e.parameter;

    // Log IPN
    logPayPalEvent('IPN', params);

    if (params.payment_status === 'Completed' && params.txn_type === 'subscr_payment') {
        const email = params.payer_email;
        const amount = parseFloat(params.mc_gross);

        // Determine plan based on amount
        let plan = 'basic';
        if (amount >= 48) plan = 'premium';
        else if (amount >= 36) plan = 'pro';
        else if (amount >= 24) plan = 'basic';

        // Register subscription
        handleRegisterSubscription({
            email: email,
            plan: plan,
            txnId: params.txn_id
        });
    }

    return createResponse({ status: 'ok' });
}

function processSubscriptionActivated(resource) {
    const email = resource.subscriber?.email_address;
    const planId = resource.plan_id;
    const subscriptionId = resource.id;

    if (!email) {
        return createResponse({ status: 'error', message: 'No email found' });
    }

    // Map PayPal plan ID to our plan
    const plan = PAYPAL_PLAN_IDS[planId] || 'basic';

    return handleRegisterSubscription({
        email: email,
        plan: plan,
        txnId: subscriptionId
    });
}

function processSubscriptionEnded(resource) {
    const email = resource.subscriber?.email_address;
    const subscriptionId = resource.id;

    if (!email) {
        return createResponse({ status: 'error', message: 'No email found' });
    }

    const sheet = getSheet('Subscribers');
    const row = findSubscriberRow(sheet, email, null);

    if (row > 0) {
        sheet.getRange(row, 6).setValue('cancelled');
        sheet.getRange(row, 8).setValue(new Date().toISOString());
    }

    return createResponse({ status: 'success', message: 'Subscription cancelled' });
}

function processPaymentCompleted(resource) {
    // For one-time payments or subscription renewals
    const email = resource.payer?.email_address;
    const amount = parseFloat(resource.amount?.total || resource.amount?.value || 0);

    if (!email) {
        return createResponse({ status: 'ok', message: 'No email found' });
    }

    // Extend existing subscription by 1 year
    const sheet = getSheet('Subscribers');
    const row = findSubscriberRow(sheet, email, null);

    if (row > 0) {
        const currentExpiry = sheet.getRange(row, 5).getValue();
        const newExpiry = new Date(currentExpiry);
        newExpiry.setFullYear(newExpiry.getFullYear() + 1);

        sheet.getRange(row, 5).setValue(newExpiry.toISOString());
        sheet.getRange(row, 6).setValue('active');
        sheet.getRange(row, 8).setValue(new Date().toISOString());
    }

    return createResponse({ status: 'success' });
}

// ==========================================
// PET DATA STORAGE (Existing functionality)
// ==========================================

function handleRead(id) {
    if (!id) {
        return createResponse({ status: 'error', message: 'ID required' });
    }

    const sheet = getSheet('PetData');
    const data = sheet.getDataRange().getValues();

    for (let i = 1; i < data.length; i++) {
        if (data[i][0] === id) {
            try {
                const parsedData = JSON.parse(data[i][1]);
                return createResponse(parsedData);
            } catch (e) {
                return createResponse({ status: 'error', message: 'Invalid data format' });
            }
        }
    }

    return createResponse({ status: 'not_found' });
}

function handleSave(id, petData) {
    if (!id) {
        return createResponse({ status: 'error', message: 'ID required' });
    }

    const sheet = getSheet('PetData');
    const data = sheet.getDataRange().getValues();
    let rowToUpdate = -1;

    // Find existing row
    for (let i = 1; i < data.length; i++) {
        if (data[i][0] === id) {
            rowToUpdate = i + 1;
            break;
        }
    }

    const dataString = JSON.stringify(petData);
    const now = new Date().toISOString();

    if (rowToUpdate > 0) {
        sheet.getRange(rowToUpdate, 2).setValue(dataString);
        sheet.getRange(rowToUpdate, 3).setValue(now);
    } else {
        sheet.appendRow([id, dataString, now]);
    }

    return createResponse({ status: 'success' });
}

function handleUploadImage(base64Image) {
    if (!base64Image) {
        return createResponse({ status: 'error', message: 'No image provided' });
    }

    try {
        // Remove data URL prefix if present
        const base64Data = base64Image.replace(/^data:image\/\w+;base64,/, '');
        const blob = Utilities.newBlob(Utilities.base64Decode(base64Data), 'image/png', 'pet_photo_' + Date.now() + '.png');

        // Get or create photos folder
        const folders = DriveApp.getFoldersByName('MHM_Fotos');
        let folder;
        if (folders.hasNext()) {
            folder = folders.next();
        } else {
            folder = DriveApp.createFolder('MHM_Fotos');
        }

        const file = folder.createFile(blob);
        file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);

        const fileId = file.getId();
        const url = 'https://drive.google.com/uc?export=view&id=' + fileId;

        return createResponse({ status: 'success', url: url });
    } catch (error) {
        logError('uploadImage', error);
        return createResponse({ status: 'error', message: error.message });
    }
}

// ==========================================
// UTILITY FUNCTIONS
// ==========================================

function getSheet(name) {
    const ss = SpreadsheetApp.openById(SHEET_ID);
    let sheet = ss.getSheetByName(name);

    if (!sheet) {
        sheet = ss.insertSheet(name);
        // Add headers based on sheet type
        if (name === 'Subscribers') {
            sheet.appendRow(['Email', 'CloudId', 'Plan', 'CreatedAt', 'ExpiresAt', 'Status', 'TxnId', 'UpdatedAt']);
        } else if (name === 'PetData') {
            sheet.appendRow(['CloudId', 'Data', 'UpdatedAt']);
        } else if (name === 'Logs') {
            sheet.appendRow(['Timestamp', 'EventType', 'Data']);
        } else if (name === 'VerificationCodes') {
            sheet.appendRow(['Email', 'Code', 'ExpiresAt', 'CloudId']);
        } else if (name === 'UserAccounts') {
            sheet.appendRow(['Email', 'CloudId', 'LinkedAt']);
        }
    }

    return sheet;
}

function findSubscriberRow(sheet, email, cloudId) {
    const data = sheet.getDataRange().getValues();

    for (let i = 1; i < data.length; i++) {
        if ((email && data[i][0] === email) || (cloudId && data[i][1] === cloudId)) {
            return i + 1;
        }
    }

    return -1;
}

function generateRandomString(length) {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let result = '';
    for (let i = 0; i < length; i++) {
        result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
}

function createResponse(data) {
    return ContentService
        .createTextOutput(JSON.stringify(data))
        .setMimeType(ContentService.MimeType.JSON);
}

function logPayPalEvent(eventType, data) {
    try {
        const sheet = getSheet('Logs');
        sheet.appendRow([
            new Date().toISOString(),
            eventType,
            JSON.stringify(data).substring(0, 50000) // Limit data size
        ]);
    } catch (e) {
        console.error('Error logging PayPal event:', e);
    }
}

function logError(context, error) {
    try {
        const sheet = getSheet('Logs');
        sheet.appendRow([
            new Date().toISOString(),
            'ERROR: ' + context,
            error.message + '\n' + error.stack
        ]);
    } catch (e) {
        console.error('Error logging error:', e);
    }
}

// ==========================================
// EMAIL VERIFICATION & ACCOUNT LINKING
// ==========================================

/**
 * Envía un código de verificación al email
 */
function handleSendVerificationCode(email, cloudId) {
    if (!email) {
        return createResponse({ status: 'error', message: 'Email requerido' });
    }

    // Generate 6-digit code
    const code = Math.floor(100000 + Math.random() * 900000).toString();
    const expiry = new Date();
    expiry.setMinutes(expiry.getMinutes() + 10); // Expires in 10 minutes

    // Save code to VerificationCodes sheet
    const sheet = getSheet('VerificationCodes');

    // Remove any existing codes for this email
    const data = sheet.getDataRange().getValues();
    for (let i = data.length - 1; i >= 1; i--) {
        if (data[i][0] === email) {
            sheet.deleteRow(i + 1);
        }
    }

    // Add new code
    sheet.appendRow([email, code, expiry.toISOString(), cloudId || '']);

    // Send email with verification code
    try {
        MailApp.sendEmail({
            to: email,
            subject: '🐾 Tu código de verificación - MHM Pets',
            htmlBody: `
                <!DOCTYPE html>
                <html>
                <head>
                    <style>
                        body { font-family: Arial, sans-serif; background: #f5f5f5; padding: 20px; }
                        .container { max-width: 500px; margin: 0 auto; background: white; border-radius: 15px; overflow: hidden; box-shadow: 0 5px 20px rgba(0,0,0,0.1); }
                        .header { background: linear-gradient(135deg, #1b5e20, #4caf50); color: white; padding: 30px; text-align: center; }
                        .header h1 { margin: 0; font-size: 24px; }
                        .body { padding: 30px; text-align: center; }
                        .code { font-size: 36px; font-weight: bold; color: #1b5e20; letter-spacing: 8px; padding: 20px; background: #e8f5e9; border-radius: 10px; margin: 20px 0; }
                        .note { color: #666; font-size: 14px; margin-top: 20px; }
                        .footer { padding: 20px; text-align: center; color: #999; font-size: 12px; border-top: 1px solid #eee; }
                    </style>
                </head>
                <body>
                    <div class="container">
                        <div class="header">
                            <h1>🐾 MHM Pets</h1>
                            <p>Mi Historia Médica - Mascota</p>
                        </div>
                        <div class="body">
                            <h2>Código de Verificación</h2>
                            <p>Usa este código para verificar tu cuenta:</p>
                            <div class="code">${code}</div>
                            <p class="note">⏰ Este código expira en 10 minutos.</p>
                            <p class="note">Si no solicitaste este código, ignora este email.</p>
                        </div>
                        <div class="footer">
                            <p>MHM Pets - Tu compañero de salud veterinaria</p>
                        </div>
                    </div>
                </body>
                </html>
            `
        });

        return createResponse({
            status: 'success',
            message: 'Código enviado',
            expiresAt: expiry.toISOString()
        });
    } catch (error) {
        logError('sendVerificationCode', error);
        return createResponse({ status: 'error', message: 'Error enviando email: ' + error.message });
    }
}

/**
 * Verifica el código ingresado por el usuario
 */
function handleVerifyCode(email, code, cloudId) {
    if (!email || !code) {
        return createResponse({ status: 'error', message: 'Email y código requeridos' });
    }

    const sheet = getSheet('VerificationCodes');
    const data = sheet.getDataRange().getValues();
    const now = new Date();

    // Convert code to string for comparison
    const codeStr = String(code).trim();

    for (let i = 1; i < data.length; i++) {
        const rowEmail = String(data[i][0]).trim();
        const rowCode = String(data[i][1]).trim();
        const rowExpiry = new Date(data[i][2]);
        const rowCloudId = data[i][3];

        if (rowEmail === email && rowCode === codeStr) {
            // Check if expired
            if (now > rowExpiry) {
                // Delete expired code
                sheet.deleteRow(i + 1);
                return createResponse({ status: 'error', message: 'Código expirado' });
            }

            // Code is valid - delete it
            sheet.deleteRow(i + 1);

            // If cloudId was provided, link the email to the account
            if (cloudId) {
                linkEmailToCloudId(email, cloudId);
            }

            return createResponse({
                status: 'success',
                message: 'Código verificado',
                verified: true,
                cloudId: rowCloudId || cloudId || null
            });
        }
    }

    return createResponse({ status: 'error', message: 'Código inválido' });
}

/**
 * Vincula un email verificado a un Cloud ID
 */
function handleLinkEmail(email, cloudId) {
    if (!email || !cloudId) {
        return createResponse({ status: 'error', message: 'Email y Cloud ID requeridos' });
    }

    const result = linkEmailToCloudId(email, cloudId);
    return result;
}

/**
 * Función auxiliar para vincular email a Cloud ID
 */
function linkEmailToCloudId(email, cloudId) {
    const sheet = getSheet('UserAccounts');
    const data = sheet.getDataRange().getValues();

    // Check if email already linked to another cloudId
    for (let i = 1; i < data.length; i++) {
        if (data[i][0] === email && data[i][1] !== cloudId) {
            return createResponse({
                status: 'error',
                message: 'Este email ya está vinculado a otra cuenta'
            });
        }
        // Update existing record
        if (data[i][0] === email && data[i][1] === cloudId) {
            sheet.getRange(i + 1, 3).setValue(new Date().toISOString());
            return createResponse({
                status: 'success',
                message: 'Vinculación actualizada',
                cloudId: cloudId
            });
        }
        // Same cloudId, different email - update email
        if (data[i][1] === cloudId) {
            sheet.getRange(i + 1, 1).setValue(email);
            sheet.getRange(i + 1, 3).setValue(new Date().toISOString());
            return createResponse({
                status: 'success',
                message: 'Email actualizado',
                cloudId: cloudId
            });
        }
    }

    // Create new record
    sheet.appendRow([email, cloudId, new Date().toISOString()]);

    return createResponse({
        status: 'success',
        message: 'Email vinculado exitosamente',
        cloudId: cloudId
    });
}

/**
 * Recupera cuenta por email (envía Cloud ID al email)
 */
function handleRecoverAccount(email) {
    if (!email) {
        return createResponse({ status: 'error', message: 'Email requerido' });
    }

    const sheet = getSheet('UserAccounts');
    const data = sheet.getDataRange().getValues();

    let cloudId = null;

    // Find cloudId for this email
    for (let i = 1; i < data.length; i++) {
        if (data[i][0] === email) {
            cloudId = data[i][1];
            break;
        }
    }

    // Also check Subscribers sheet
    if (!cloudId) {
        const subSheet = getSheet('Subscribers');
        const subData = subSheet.getDataRange().getValues();
        for (let i = 1; i < subData.length; i++) {
            if (subData[i][0] === email) {
                cloudId = subData[i][1];
                break;
            }
        }
    }

    if (!cloudId) {
        return createResponse({
            status: 'error',
            message: 'No se encontró cuenta con este email'
        });
    }

    // Send recovery email
    try {
        MailApp.sendEmail({
            to: email,
            subject: '🐾 Recuperación de Cuenta - MHM Pets',
            htmlBody: `
                <!DOCTYPE html>
                <html>
                <head>
                    <style>
                        body { font-family: Arial, sans-serif; background: #f5f5f5; padding: 20px; }
                        .container { max-width: 500px; margin: 0 auto; background: white; border-radius: 15px; overflow: hidden; box-shadow: 0 5px 20px rgba(0,0,0,0.1); }
                        .header { background: linear-gradient(135deg, #1b5e20, #4caf50); color: white; padding: 30px; text-align: center; }
                        .header h1 { margin: 0; font-size: 24px; }
                        .body { padding: 30px; text-align: center; }
                        .cloudid { font-size: 32px; font-weight: bold; color: #1b5e20; letter-spacing: 4px; padding: 20px; background: #e8f5e9; border-radius: 10px; margin: 20px 0; font-family: monospace; }
                        .note { color: #666; font-size: 14px; margin-top: 20px; }
                        .footer { padding: 20px; text-align: center; color: #999; font-size: 12px; border-top: 1px solid #eee; }
                    </style>
                </head>
                <body>
                    <div class="container">
                        <div class="header">
                            <h1>🐾 MHM Pets</h1>
                            <p>Recuperación de Cuenta</p>
                        </div>
                        <div class="body">
                            <h2>¡Encontramos tu cuenta!</h2>
                            <p>Tu Cloud ID es:</p>
                            <div class="cloudid">${cloudId}</div>
                            <p class="note">📋 Usa este ID para recuperar tus datos en la app.</p>
                            <p class="note">🔒 Guarda este ID en un lugar seguro.</p>
                        </div>
                        <div class="footer">
                            <p>MHM Pets - Tu compañero de salud veterinaria</p>
                        </div>
                    </div>
                </body>
                </html>
            `
        });

        return createResponse({
            status: 'success',
            message: 'Cloud ID enviado a tu email'
        });
    } catch (error) {
        logError('recoverAccount', error);
        return createResponse({ status: 'error', message: 'Error enviando email' });
    }
}

/**
 * Obtiene cuenta por email
 */
function handleGetAccountByEmail(email) {
    if (!email) {
        return createResponse({ status: 'error', message: 'Email requerido' });
    }

    const sheet = getSheet('UserAccounts');
    const data = sheet.getDataRange().getValues();

    for (let i = 1; i < data.length; i++) {
        if (data[i][0] === email) {
            return createResponse({
                status: 'success',
                account: {
                    email: data[i][0],
                    cloudId: data[i][1],
                    linkedAt: data[i][2]
                }
            });
        }
    }

    return createResponse({ status: 'not_found', message: 'Cuenta no encontrada' });
}

/**
 * Obtiene cuenta por Cloud ID
 */
function handleGetAccountByCloudId(cloudId) {
    if (!cloudId) {
        return createResponse({ status: 'error', message: 'Cloud ID requerido' });
    }

    const sheet = getSheet('UserAccounts');
    const data = sheet.getDataRange().getValues();

    for (let i = 1; i < data.length; i++) {
        if (data[i][1] === cloudId) {
            return createResponse({
                status: 'success',
                account: {
                    email: data[i][0],
                    cloudId: data[i][1],
                    linkedAt: data[i][2]
                }
            });
        }
    }

    return createResponse({ status: 'not_found', message: 'Cuenta no encontrada' });
}

// ==========================================
// INITIALIZATION (Run once)
// ==========================================

function initializeSheets() {
    getSheet('Subscribers');
    getSheet('PetData');
    getSheet('Logs');
    getSheet('VerificationCodes');
    getSheet('UserAccounts');
    Logger.log('Sheets initialized successfully!');
}
