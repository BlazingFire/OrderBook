/**
 * The Hindi catalogue. Typed `Record<MessageKey, string>` — TOTAL, not
 * partial — so adding an English key turns this file's build red until Hindi
 * exists for it. `tools/i18n-sync.mjs` exists to make that pressure survivable
 * mid-feature: it appends the missing key with the English text and a
 * `// TODO(i18n-hi)` marker so the build goes green and the untranslated
 * strings stay one grep away.
 *
 * Every placeholder name is reproduced exactly as it appears in `en.ts` —
 * `shared/tests/i18n-coverage.test.ts` asserts identical placeholder sets per
 * key, because a translator dropping `{name}` still typechecks as a `string`.
 */

import type { MessageKey } from './keys.js';

export const HI_MESSAGES: Record<MessageKey, string> = {
  'permission.lead.convert': 'लीड को ऑर्डर में बदलें',
  'permission.orders.dispatch': 'ऑर्डर भेजें',
  'permission.record.reassignOwner': 'रिकॉर्ड का स्वामी बदलें',
  'permission.stock.adjust': 'भौतिक गणना से स्टॉक समायोजित करें',
  'permission.users.manage': 'उपयोगकर्ता प्रबंधित करें',
  'permission.users.viewPassword': 'संग्रहीत पासवर्ड दिखाएँ',
  'permission.roles.assign': 'उपयोगकर्ताओं को भूमिकाएँ सौंपें',
  'permission.panels.manage': 'ऑफ़िस पैनल प्रबंधित करें',
  'permission.api.manage': 'Manage API keys and connections',
  'permission.settings.manage': 'सेटिंग्स प्रबंधित करें',
  'permission.storage.manage': 'स्टोरेज निर्यात, पुनर्स्थापित और स्थानांतरित करें',
  'permission.fields.manage': 'पाइपलाइन, चरण और कस्टम फ़ील्ड प्रबंधित करें',
  'permission.sync.resolveConflicts': 'सिंक टकराव सुलझाएँ',

  'permission.leads.view': 'लीड देखें',
  'permission.leads.create': 'लीड बनाएँ',
  'permission.leads.edit': 'लीड संपादित करें',
  'permission.leads.delete': 'लीड हटाएँ',
  'permission.leads.export': 'लीड निर्यात करें',
  'permission.leads.bulk': 'लीड थोक में संपादित करें',
  'permission.orders.view': 'ऑर्डर देखें',
  'permission.orders.edit': 'ऑर्डर संपादित करें',
  'permission.orders.delete': 'ऑर्डर हटाएँ',
  'permission.orders.export': 'ऑर्डर निर्यात करें',
  'permission.orders.bulk': 'ऑर्डर थोक में संपादित करें',
  'permission.parties.view': 'पार्टियाँ देखें',
  'permission.parties.create': 'पार्टी बनाएँ',
  'permission.parties.edit': 'पार्टी संपादित करें',
  'permission.parties.delete': 'पार्टी हटाएँ',
  'permission.parties.export': 'पार्टियाँ निर्यात करें',
  'permission.parties.bulk': 'पार्टियाँ थोक में संपादित करें',
  'permission.products.view': 'उत्पाद देखें',
  'permission.products.create': 'उत्पाद बनाएँ',
  'permission.products.edit': 'उत्पाद संपादित करें',
  'permission.products.delete': 'उत्पाद हटाएँ',
  'permission.products.export': 'उत्पाद निर्यात करें',
  'permission.products.bulk': 'उत्पाद थोक में संपादित करें',
  'permission.inventory.view': 'इन्वेंट्री देखें',
  'permission.inventory.edit': 'इन्वेंट्री संपादित करें',
  'permission.inventory.export': 'इन्वेंट्री निर्यात करें',
  'permission.reports.view': 'रिपोर्ट देखें',
  'permission.reports.export': 'रिपोर्ट निर्यात करें',
  'permission.roles.view': 'भूमिकाएँ देखें',
  'permission.roles.create': 'भूमिका बनाएँ',
  'permission.roles.edit': 'भूमिका संपादित करें',
  'permission.roles.delete': 'भूमिका हटाएँ',

  'permission.logs.view': 'गतिविधि लॉग देखें',
  'permission.logs.export': 'गतिविधि लॉग निर्यात करें',
  'permission.logs.verifyChain': 'ऑडिट श्रृंखला सत्यापित करें',
  'permission.recycleBin.view': 'रीसायकल बिन देखें',
  'permission.recycleBin.viewAll': 'सबके द्वारा हटाई गई वस्तुएँ देखें',
  'permission.fields.view': 'पाइपलाइन, चरण और कस्टम फ़ील्ड देखें',
  'permission.party.accessAll': 'हर पार्टी देखें, चाहे सौंपी गई हो या नहीं',
  'permission.party.assign': 'तय करें कि कौन किस पार्टी को देख और प्रबंधित कर सकता है',

  'module.leads': 'लीड',
  'module.orders': 'ऑर्डर',
  'module.parties': 'पार्टियाँ',
  'module.products': 'उत्पाद',
  'module.inventory': 'इन्वेंट्री',
  'module.reports': 'रिपोर्ट',
  'module.roles': 'भूमिकाएँ',
  'module.logs': 'लॉग',

  'fieldSet.lead.sourcePlatform': 'लीड स्रोत',
  'fieldSet.stock.colour': 'रंग',
  'fieldSet.product.brand': 'ब्रांड',
  'fieldSet.line.packaging': 'पैकेजिंग',
  'fieldSet.line.grade': 'ग्रेड',

  'action.view': 'देखें',
  'action.create': 'बनाएँ',
  'action.edit': 'संपादित करें',
  'action.delete': 'हटाएँ',
  'action.export': 'निर्यात करें',
  'action.bulk': 'थोक',

  'capabilityGroup.workflow': 'कार्यप्रवाह',
  'capabilityGroup.stock': 'स्टॉक',
  'capabilityGroup.admin': 'प्रशासन',

  'roleTemplate.sales': 'बिक्री',
  'roleTemplate.dispatch': 'डिस्पैच',

  'setting.security.passwordRevealEnabled.label': 'पासवर्ड याद रखें ताकि उन्हें फिर दिखाया जा सके',
  'setting.security.passwordRevealEnabled.help':
    'जब तक यह चालू है, इस नेटवर्क पर टाइप किया गया हर पासवर्ड ऐसे रूप में रखा जाता है जिसे प्रशासक पढ़ सकता है। इसे बंद करने पर पहले से रखे गए सभी पासवर्ड हटा दिए जाते हैं।',
  'setting.externalApi.enabled.label': 'अन्य सॉफ़्टवेयर को जुड़ने दें',
  'setting.externalApi.enabled.help':
    'नेटवर्क के अन्य प्रोग्रामों से कुंजी-युक्त अनुरोधों के लिए इस मास्टर को खोलता है।',
  'setting.inventory.freeToSell.label': 'बिक्री-योग्य स्टॉक ट्रैक करें',
  'setting.inventory.freeToSell.help':
    'चालू होने पर हर स्टॉक आँकड़ा तीन हिस्सों में दिखता है — उपलब्ध, खुले ऑर्डरों के लिए आरक्षित, और बिक्री-योग्य — और कम स्टॉक बिक्री-योग्य पर आँका जाता है। बंद होने पर हर वेरिएंट के लिए एक ही संख्या दिखती है, फ़र्श पर रखे पीस, और आरक्षित/बिक्री-योग्य कहीं नहीं दिखते। ऑर्डर नीचे अपना स्टॉक रोके रखते हैं, इसलिए वापस चालू करने पर सही तस्वीर दिखती है।',
  'setting.catalog.importCreatesCategories.label': 'उत्पाद आयात को नई श्रेणियाँ बनाने दें',
  'setting.catalog.importCreatesCategories.help':
    'चालू रहने पर बल्क आयात शीट में लिखी श्रेणी के अनुसार उत्पाद रखता है, और श्रेणी नई हो तो बना देता है। बंद रहने पर श्रेणी पहले से होनी चाहिए — जिस पंक्ति में ऐसी श्रेणी लिखी है जो आपके पास नहीं है वह पंक्ति संख्या सहित अस्वीकार होगी ताकि आप वर्तनी ठीक कर सकें, और जिस पंक्ति में कोई श्रेणी नहीं है वह पहले की तरह आयात होगी।',
  'error.notFound': '{what} नहीं मिला',
  'error.forbidden.missingPermission': 'अनुमति नहीं है: {permission}',
  'error.forbidden.passwordRevealDisabled':
    'इस कंपनी के लिए पासवर्ड पुनर्प्राप्ति बंद है। कोई प्रशासक इसे सेटिंग्स में चालू कर सकता है।',
  'validation.connector.credentialMissing': 'This connection needs its credential entered again',
  'validation.connector.dryRunRequired': 'Run a dry run at the current mapping before importing',
  'validation.connector.entityUnknown': 'That is not something this connection can import',
  'validation.connector.intervalTooShort': 'A schedule runs at most once every {minutes} minutes',
  'validation.connector.labelRequired': 'Give the connection a name',
  'validation.connector.notFlaggable': '{field} cannot raise a conflict — choose which side wins',
  'validation.connector.remoteIdRequired': 'Say which field holds the id the other system uses',
  'validation.connector.runAsRequired': 'Choose whose permissions this connection writes with',
  'validation.connector.slugRequired': 'Give the connection a short code',
  'validation.connector.transformUnknown': 'That is not a transform this product knows',
  'validation.connector.urlInvalid': 'That is not a web address',
  'validation.connector.urlScheme': 'A connection address must start with http or https',
  'validation.connector.urlSelf': 'A connection cannot point back at this Master',
  // TODO(i18n-hi)
  'validation.developer.passwordRequired': 'Enter the developer password',
  // TODO(i18n-hi)
  'validation.developer.confirmationRequired': 'Type RESET to confirm',
  'validation.request.bodyRequired': 'That request needs a JSON body',
  'validation.apiKey.labelRequired': 'Give the key a label so it can be recognised later',
  'validation.apiKey.scopesRequired': 'Choose at least one permission for this key',
  'error.rateLimited': 'Too many requests. Try again in {seconds} seconds.',
  'error.unauthorized.apiKeyInvalid': 'That API key is not valid',
  'error.unauthorized.apiKeyExpired': 'That API key has expired or been revoked',
  'error.unauthorized': 'साइन इन नहीं है',
  'error.unauthorized.signInFailed': 'साइन-इन विफल',
  'error.unauthorized.accountDeactivated': 'यह खाता निष्क्रिय कर दिया गया है',
  'error.unauthorized.noRole':
    'इस खाते की कोई भूमिका नहीं है। किसी प्रशासक से भूमिका देने को कहें।',
  'error.unauthorized.currentPasswordIncorrect': 'आपका मौजूदा पासवर्ड सही नहीं है',
  'error.unauthorized.tooManyAttempts': 'बहुत अधिक विफल प्रयास। {seconds} सेकंड में फिर कोशिश करें।',
  'error.unauthorized.pairingNotAccepting':
    'मास्टर पैनल अभी नए पैनल स्वीकार नहीं कर रहा है। मास्टर पर "ऑफ़िस पैनल जोड़ें" खोलकर फिर कोशिश करें।',
  'error.unauthorized.incorrectPairingPassword': 'जोड़ी पासवर्ड गलत है',
  'error.unauthorized.differentMaster': 'यह उस मास्टर पैनल से अलग है जिसे आपने दर्ज किया था',
  'error.unauthorized.panelNotPaired': 'यह पैनल जोड़ा नहीं गया है',
  'error.unauthorized.panelCredentialsInvalid': 'पैनल क्रेडेंशियल मान्य नहीं हैं',
  // TODO(i18n-hi)
  'error.unauthorized.developerPassword': 'That is not the developer password',
  // TODO(i18n-hi)
  'error.unauthorized.developerMode': 'Developer mode is not unlocked',
  'error.forbidden.partyNotAssigned': 'वह पार्टी आपको नहीं सौंपी गई है',
  'error.forbidden.partyViewOnly': 'आप वह पार्टी देख सकते हैं, पर उसके रिकॉर्ड बदल नहीं सकते',
  'error.tenantViolation': '{what} इस कंपनी से संबंधित नहीं है',
  'error.conflict.alreadySetUp': 'यह मास्टर पैनल पहले ही सेटअप किया जा चुका है',
  'error.conflict.notSetUp': 'यह मास्टर पैनल अभी तक सेटअप नहीं किया गया है',
  'error.conflict.productCodeTaken': 'उत्पाद कोड "{productCode}" पहले से उपयोग में है',
  'error.conflict.categoryCodeTaken': 'किसी दूसरे उत्पाद का कोड पहले से {code} है',
  'error.conflict.categoryNameTaken': 'इस ब्रांड में {name} नाम का उत्पाद पहले से है',
  'error.conflict.nameTaken.role': '"{value}" नाम की भूमिका पहले से मौजूद है',
  'error.conflict.nameTaken.username': 'उपयोगकर्ता नाम "{value}" पहले से लिया जा चुका है',
  'error.conflict.staleVersion':
    'किसी और ने इसे पहले ही सहेज लिया। बदलाव देखने के लिए फिर लोड करें।',
  'error.internal.panelNoTenant': 'पैनल का कोई टेनेंट नहीं है',
  'error.internal.sessionNoTenant': 'सत्र का कोई टेनेंट नहीं है',
  'error.internal.backupHashChainInvalid':
    'पुनर्स्थापित ऑडिट ट्रेल अपने ही हैश के विरुद्ध सत्यापित नहीं हुआ — पुनर्स्थापना अस्वीकृत',
  'error.validation.backupWrongPassphrase': 'गलत पासफ़्रेज़',
  'error.validation.backupCorruptFile': 'यह बैकअप फ़ाइल खराब या अधूरी है',
  'error.validation.backupFormatTooNew':
    'यह बैकअप OrderBook के एक नए संस्करण (ऐप {fileAppVersion}) द्वारा बनाया गया था जिसे यह इंस्टॉलेशन आयात नहीं कर सकता। पहले इस इंस्टॉलेशन को अपडेट करें।',
  'error.conflict.dataDirectoryPopulated':
    'इस इंस्टॉलेशन में पहले से डेटा है। पुनर्स्थापित करने से पहले इसे मिटाने की पुष्टि करें।',
  'error.unavailable': 'मास्टर पैनल तक नहीं पहुँचा जा सका। लिंक वापस आने पर फिर कोशिश करें।',
  'error.unknown': 'कुछ गड़बड़ हो गई',
  'error.requestFailed': 'अनुरोध विफल रहा',
  'error.requestTimedOut': 'सर्वर ने समय पर जवाब नहीं दिया',
  'error.requestCancelled': 'अनुरोध रद्द कर दिया गया',

  'error.generic.notFound': 'नहीं मिला',
  'error.generic.conflict': 'किसी और ने टकराव वाला बदलाव किया',
  'error.generic.validation': 'यह मान्य नहीं है',
  'error.generic.forbidden': 'आपको ऐसा करने की अनुमति नहीं है',
  'error.generic.internal': 'सर्वर पर कुछ गड़बड़ हो गई',
  'error.generic.masterCommandFailed': 'मास्टर पैनल वह कार्रवाई पूरी नहीं कर सका',
  'error.generic.invalidRequest': 'वह अनुरोध मान्य नहीं था',
  'error.generic.notSynced': 'इस पैनल ने अभी तक मास्टर के साथ सिंक नहीं किया है',
  'error.generic.queueFailed': 'उस कार्रवाई को बाद के लिए कतारबद्ध नहीं किया जा सका',
  'error.generic.scanFailed': 'मास्टर पैनल के लिए स्कैन नहीं किया जा सका',
  'error.generic.pairingFailed': 'जोड़ी बनाना विफल',
  'error.generic.invalidCredentials': 'उपयोगकर्ता नाम या पासवर्ड गलत है',
  'error.generic.lockedOut': 'बहुत अधिक विफल प्रयास। बाद में फिर कोशिश करें।',
  'error.generic.unknownHere': 'यह इस पैनल पर उपलब्ध नहीं है',
  'error.generic.offlineSignInDisabled':
    'साइन इन के लिए मास्टर पैनल चाहिए। यह कंपनी उसके बंद रहते साइन इन करने की अनुमति नहीं देती।',

  'validation.backup.passphraseTooShort': 'निर्यात पासफ़्रेज़ कम से कम {min} अक्षरों का होना चाहिए',
  'validation.backup.passphraseRequired': 'निर्यात पासफ़्रेज़ दर्ज करें',
  'validation.backup.scopeRequired': 'चुनें कि पूरा डेटाबेस निर्यात करना है या चुनी हुई कंपनियाँ',
  'validation.backup.fileRequired': 'एक बैकअप फ़ाइल चुनें',
  'validation.backup.tenantsRequired': 'निर्यात के लिए कम से कम एक कंपनी चुनें',
  'validation.user.username.required': 'एक उपयोगकर्ता नाम दर्ज करें',
  'validation.user.displayName.required': 'एक प्रदर्शन नाम दर्ज करें',
  'validation.user.role.mustExist': 'ऐसी भूमिका चुनें जो मौजूद हो',
  'validation.conflict.alreadyReviewed': 'उस टकराव की पहले ही समीक्षा हो चुकी है',
  'validation.conflict.cannotRestoreField':
    '"{field}" को स्वतः पुनर्स्थापित नहीं किया जा सकता — रिकॉर्ड सीधे संपादित करें',
  'validation.conflict.cannotRestoreEntity': '{entity} मान को स्वतः पुनर्स्थापित नहीं किया जा सकता',
  'validation.conflict.actionRequired': 'चुनें कि मौजूदा मान रखना है या दूसरा पुनर्स्थापित करना है',
  'validation.order.dispatchedLocked': 'यह ऑर्डर भेजा जा चुका है और अब संपादित नहीं किया जा सकता',
  'validation.order.weightNegative': 'वज़न ऋणात्मक नहीं हो सकता',
  'validation.order.alreadyDispatched': 'यह ऑर्डर पहले ही भेजा जा चुका है',
  'validation.order.stockAlreadyMoved': 'इस ऑर्डर के लिए स्टॉक पहले ही स्थानांतरित हो चुका है',
  'validation.remark.textRequired': 'टिप्पणी में कुछ पाठ होना चाहिए',
  'validation.stock.boxesArrivedRequired': 'कितने बॉक्स आए यह दर्ज करें',
  'validation.stock.countedBoxesRequired': 'गिने गए बॉक्सों की संख्या दर्ज करें',
  'validation.stock.adjustmentNoteRequired': 'बताइए कि यह गिनती क्यों सुधारी जा रही है',
  'validation.lead.partyRequired': 'इस लीड के लिए एक पार्टी चुनें',
  'validation.lead.itemsRequired': 'इस लीड में कम से कम एक उत्पाद जोड़ें',
  'validation.lead.partyMissing': 'चुनी गई पार्टी अब मौजूद नहीं है',
  'validation.lead.convertedLocked': 'यह लीड ऑर्डर बन चुकी है और अब संपादित नहीं की जा सकती',
  'validation.lead.productMissing': 'चुने गए उत्पादों में से एक अब मौजूद नहीं है',
  'validation.lead.quantityRequired': '{productName} के लिए मात्रा जोड़ें',
  'validation.lead.sourceInvalid': '"{value}" कोई कॉन्फ़िगर किया गया लीड स्रोत नहीं है',
  'validation.lead.alreadyConverted': 'यह लीड पहले ही ऑर्डर में बदली जा चुकी है',
  'validation.lead.noItemsToConvert': 'ऑर्डर बनने से पहले लीड में कम से कम एक उत्पाद होना चाहिए',
  'validation.lead.quantityMissingOnConvert':
    'बदलने से पहले हर पंक्ति में मात्रा होनी चाहिए — जाँचें: {items}',
  'validation.lead.packagingMissing': 'बदलने से पहले {items} के लिए पैकेजिंग चुनें',
  'validation.panel.setupIncomplete': 'इस मास्टर पैनल का पहली बार का सेटअप पूरा नहीं हुआ है',
  'validation.panel.nameEmpty': 'पैनल का नाम खाली नहीं हो सकता',
  'validation.panel.nameRequired': 'पैनल का नाम आवश्यक है',
  'validation.panel.notActive': 'यह पैनल सक्रिय नहीं है, इसलिए इसका प्रबंधन नहीं किया जा सकता',
  'validation.panel.notConnected': 'वह ऑफिस पैनल ऑफ़लाइन है — जब वह जुड़ा हो तब कोशिश करें',
  'validation.panel.noAnswer': 'उस ऑफिस पैनल ने कोई उत्तर नहीं दिया',
  'validation.panel.storagePathRequired': 'उस पीसी पर फ़ोल्डर का पथ भरें',
  'validation.panel.storagePathRelative': 'ड्राइव या रूट से शुरू होने वाला पूरा पथ भरें',
  'validation.panel.notesTooLong': 'टिप्पणी {max} अक्षरों से कम रखें',
  'validation.panel.fieldInvalid': 'ऑफिस पैनल के लिए वह मान मान्य नहीं है',
  'validation.password.tooShort': 'कम से कम 8 अक्षरों का पासवर्ड चुनें',
  'validation.password.bothRequired': 'अपना मौजूदा और नया पासवर्ड दर्ज करें',
  'validation.setting.invalid': 'सेटिंग {key} के लिए वह मान मान्य नहीं है',
  'validation.party.nameRequired': 'पार्टी का नाम आवश्यक है',
  'validation.updates.checksumMismatch':
    'वह सेटअप फ़ाइल अपने चेकसम से मेल नहीं खाती — यह खराब या अधूरी हो सकती है। इसे फिर से कॉपी करें।',
  'validation.updates.noneAvailable': 'इंस्टॉल करने के लिए कोई नया संस्करण नहीं है',
  'validation.partyAccess.levelInvalid': 'पहुँच स्तर view या manage होना चाहिए',
  'validation.partyAccess.userUnknown': '{userId} आईडी वाला कोई सक्रिय खाता नहीं है',
  'validation.stock.levelRange': 'अधिकतम, न्यूनतम से कम नहीं हो सकता',
  'validation.stock.levelNegative': 'स्टॉक स्तर ऋणात्मक नहीं हो सकता',
  'validation.pick.unknownKind': 'यह ऐसी चीज़ नहीं है जिसे यह पैनल खोज सके',
  'validation.product.nameRequired': 'उत्पाद का नाम आवश्यक है',
  'validation.product.categoryRequired': 'यह उप-उत्पाद जिस उत्पाद के अंतर्गत है, वह चुनें',
  'validation.product.categoryCodeUnknown': 'कोड {code} वाला कोई उत्पाद नहीं है',
  'validation.product.nameTaken': '{category} में {name} नाम का उप-उत्पाद पहले से है',
  'validation.category.nameRequired': 'उत्पाद का नाम दर्ज करें',
  'validation.category.codeRequired': 'उत्पाद का कोड दर्ज करें',
  'validation.category.codeInvalid': 'उत्पाद कोड में केवल अक्षर और अंक होते हैं',
  'validation.category.sortOrder': 'कैटलॉग क्रम शून्य या उससे बड़ी पूर्ण संख्या होनी चाहिए',
  'validation.category.brandUnknown': '{brand} ब्रांड सूची में नहीं है',
  'validation.product.variantRequired': 'उत्पाद में कम से कम एक कोड होना चाहिए',
  'validation.product.variantCodeRequired': 'हर वेरिएंट के लिए कोड आवश्यक है',
  'validation.product.variantCodeDuplicate': 'इस उत्पाद के दो वेरिएंट का कोड एक ही है',
  'validation.product.variantLabelRequired': 'हर वेरिएंट के लिए रंग या वेरिएंट का नाम आवश्यक है',
  'validation.product.variantLabelDuplicate': 'इस उत्पाद के दो वेरिएंट का नाम एक ही है',
  'validation.product.variantLabelUnexpected':
    'बिना वेरिएंट वाले उत्पाद में एक ही कोड होता है — और जोड़ने के लिए वेरिएंट चालू करें',
  'validation.product.weightPositive': 'वज़न शून्य से बड़ी संख्या होनी चाहिए',
  'validation.product.restoreCodesTaken':
    'पुनर्स्थापित नहीं किया जा सकता — {codes} अब किसी अन्य उत्पाद में उपयोग हो रहा है',
  'validation.lead.variantMissing': 'चुने गए उत्पाद वेरिएंट में से एक अब मौजूद नहीं है',
  'validation.stock.variantRequired': 'चुनें कि यह स्टॉक किस उत्पाद वेरिएंट का है',
  // --- Bulk product import: file-level refusals and per-row issues ----------
  'validation.import.fileRequired': 'कोई CSV या Excel फ़ाइल चुनें',
  'validation.import.unsupportedFormat': 'केवल .csv और .xlsx फ़ाइलें आयात की जा सकती हैं',
  'validation.import.unreadable': 'यह फ़ाइल स्प्रेडशीट के रूप में पढ़ी नहीं जा सकी',
  'validation.import.emptyFile': 'फ़ाइल में आयात करने के लिए कोई पंक्ति नहीं है',
  'validation.import.missingColumn': 'फ़ाइल में "{column}" कॉलम नहीं है',
  'validation.import.notANumber': '"{column}" एक संख्या होनी चाहिए',
  'validation.import.invalidValue': '"{column}" इनमें से एक होना चाहिए: {allowed}',
  'validation.import.duplicateInFile': '"{column}" पंक्ति {firstRow} में दोहराया गया है',
  'validation.import.mixedVariants':
    '{name} की कुछ पंक्तियों में वेरिएंट है और कुछ में नहीं — हर पंक्ति भरें या हर पंक्ति खाली छोड़ें',
  'validation.import.codesSplit': '{name} के कोड पहले से एक से अधिक उत्पादों के हैं',
  'validation.import.unknownCategory':
    '"{categoryName}" नाम की कोई श्रेणी नहीं है — यह कंपनी आयात से नई श्रेणी बनाने की अनुमति नहीं देती',
  'validation.import.rowFailed': 'पंक्ति सहेजी नहीं जा सकी: {reason}',
  'import.skip.codeExists': 'उत्पाद कोड "{productCode}" पहले से मौजूद है — छोड़ा गया',
  'validation.role.nameRequired': 'भूमिका को एक नाम दें',
  'validation.role.tierInvalid': 'एक मान्य स्तर चुनें',
  'validation.permissions.unknown.one': 'अज्ञात अनुमति: {keys}',
  'validation.permissions.unknown.other': 'अज्ञात अनुमतियाँ: {keys}',
  'validation.permissions.aboveTier':
    '{tier} स्तर इन्हें नहीं रख सकता: {keys}। स्तर बढ़ाएँ या इन्हें हटाएँ।',
  'validation.role.systemUndeletable': '"{roleName}" एक सिस्टम भूमिका है और इसे हटाया नहीं जा सकता',
  'validation.role.systemTierLocked':
    '"{roleName}" एक सिस्टम भूमिका है और इसका स्तर नहीं बदला जा सकता',
  'validation.role.lastAdminRequired':
    'कम से कम एक सक्रिय प्रशासक बना रहना चाहिए। पहले किसी और को प्रशासक भूमिका दें।',
  'validation.role.irrevocableCapabilityLost':
    'इससे कोई भी {capabilities} नहीं कर पाएगा। पहले किसी प्रशासक-स्तर की भूमिका को यह दें।',
  'validation.role.stillAssigned':
    '"{roleName}" अभी भी कम से कम एक व्यक्ति को सौंपी हुई है। पहले उन्हें किसी और भूमिका में ले जाएँ।',
  'validation.expectedVersion.required':
    'इस बदलाव में यह नहीं बताया गया कि यह किस संस्करण पर आधारित था, इसलिए इसे सुरक्षित रूप से सहेजा नहीं जा सकता।',
  'validation.stage.differentPipeline': 'वह चरण एक अलग पाइपलाइन से संबंधित है',
  'validation.stage.leadConverted':
    'यह लीड पहले ही ऑर्डर बन चुकी है — इसके बजाय ऑर्डर को स्थानांतरित करें',
  'validation.stage.archived': 'वह चरण संग्रहीत है और नए रिकॉर्ड स्वीकार नहीं कर सकता',
  'validation.stage.required': 'एक चरण चुनें',
  'validation.signIn.credentialsRequired': 'अपना आईडी और पासवर्ड दर्ज करें',
  'validation.pairing.invalidRequest': 'जोड़ी अनुरोध मान्य नहीं है',
  'validation.cursor.malformed': 'परिणामों के इस पृष्ठ का लिंक अब मान्य नहीं है',
  'error.conflict.parentDeleted': 'एक या अधिक संबंधित रिकॉर्ड अभी भी रीसायकल बिन में हैं',
  'error.conflict.restoreCollision': 'एक मौजूदा रिकॉर्ड पहले से ही इस {field} का उपयोग कर रहा है',
  'error.conflict.passwordNotStored':
    'इस व्यक्ति के लिए अभी कोई पासवर्ड संग्रहीत नहीं है। अगली बार जब वे इस नेटवर्क पर साइन इन करेंगे तब वह याद रखा जाएगा।',
  'error.conflict.vaultUnreadable':
    'संग्रहीत पासवर्ड इस मशीन पर पढ़ा नहीं जा सका। इसके बजाय पासवर्ड रीसेट करें।',
  'error.conflict.blockedByLiveReferences':
    'अन्य रिकॉर्ड अभी भी इसका संदर्भ देते हैं, पहले उन्हें निपटाएँ',
  'validation.recycleBin.unknownEntityType': 'यह रीसायकल बिन की इकाई प्रकार नहीं है',
  'validation.recycleBin.idRequired': 'उस रिकॉर्ड का कोई आईडी नहीं है',

  'validation.logs.date.invalid': 'एक मान्य दिनांक सीमा दर्ज करें',
  'validation.logs.direction.invalid': 'यह एक मान्य पेजिंग दिशा नहीं है',
  'validation.logs.verify.limitExceeded': 'वह सत्यापन सीमा बहुत बड़ी है',
  'validation.logs.verify.fromSequenceInvalid': 'यह एक मान्य श्रृंखला स्थिति नहीं है',

  'validation.reports.range.invalid': 'एक मान्य महीना सीमा दर्ज करें',
  'validation.reports.range.fromMonthRequired': 'कस्टम सीमा के लिए एक प्रारंभिक महीना चुनें',
  'validation.reports.range.toBeforeFrom': 'अंतिम महीना प्रारंभिक महीने से पहले नहीं हो सकता',
  'validation.reports.range.tooWide': 'वह सीमा {maxMonths} महीनों से अधिक फैली हुई है',
  'validation.reports.kind.unknown': 'यह इस उत्पाद द्वारा बनाई जाने वाली रिपोर्ट नहीं है',

  'error.pdf.fontMissing': 'इस इंस्टॉलेशन में एक PDF फ़ॉन्ट नहीं मिला: {file}',

  'validation.image.fileRequired': 'एक इमेज फ़ाइल चुनें',
  'validation.image.tooLarge': 'वह फ़ाइल बहुत बड़ी है',
  'validation.image.unreadable': 'वह फ़ाइल इमेज के रूप में नहीं पढ़ी जा सकी — {reason}',
  'validation.image.crop.invalid': 'क्रॉप सही तरीके से लागू नहीं हुआ — फिर से प्रयास करें',
  'validation.image.crop.tooSmall': 'क्रॉप क्षेत्र बहुत छोटा है',
  'validation.image.crop.outOfBounds': 'क्रॉप क्षेत्र इमेज के बाहर है',
  'validation.image.rotation.invalid': 'रोटेशन सही तरीके से लागू नहीं हुआ — फिर से प्रयास करें',
  'validation.image.reorder.notPermutation': 'यह इस उत्पाद की इमेज का पूरा पुनर्क्रम नहीं है',

  'validation.fields.listKeyRequired': 'चुनें कि यह कौन-सी सूची है',
  'validation.fields.entityInvalid': 'एक मान्य रिकॉर्ड प्रकार चुनें',
  'validation.fields.valueRequired': 'एक मान दर्ज करें',
  'validation.fields.valueImmutable': 'बनने के बाद मान नहीं बदला जा सकता — इसके बजाय लेबल बदलें',
  'validation.fields.hexInvalid': 'रंग को #RRGGBB के रूप में दर्ज करें',
  'validation.fields.reorderMismatch':
    'यह पूरी, मौजूदा सूची नहीं है — पुनः लोड करके फिर कोशिश करें',
  'validation.fields.fieldTypeInvalid': 'एक मान्य फ़ील्ड प्रकार चुनें',
  'validation.fields.keyRequired': 'एक की (key) दर्ज करें',
  'validation.fields.optionsRequired': 'सेलेक्ट फ़ील्ड में कम से कम एक विकल्प होना चाहिए',
  'error.conflict.optionValueTaken': '"{value}" इस सूची में पहले से मौजूद है',
  'error.conflict.definitionKeyTaken': '"{key}" की के साथ एक कस्टम फ़ील्ड पहले से मौजूद है',
  'error.conflict.stageOccupied': 'इस चरण में अभी भी सक्रिय रिकॉर्ड हैं — पहले उन्हें ले जाएँ',
  'error.conflict.stageIsDefault':
    'यह पाइपलाइन का डिफ़ॉल्ट चरण है और इसे संग्रहीत नहीं किया जा सकता',

  'activity.stock.inbound': '{actor} ने {product} के लिए {quantity} बॉक्स दर्ज किए',
  'activity.stock.adjusted': '{actor} ने {product} की गिनी गई स्टॉक समायोजित की',
  'activity.stock.levels_changed': '{actor} ने {product} के स्टॉक स्तर बदले',
  'activity.user.created': '{actor} ने {name} के लिए खाता बनाया',
  'activity.user.updated': '{actor} ने {name} को अपडेट किया',
  'activity.user.deactivated': '{actor} ने {name} को निष्क्रिय किया',
  'activity.ai_run.asked': '{actor} ने सहायक से कुछ पूछा',
  'activity.ai_run.drafted': '{actor} ने सहायक से कुछ ड्राफ़्ट करवाया',
  'activity.ai_run.applied': '{actor} ने सहायक का सुझाया बदलाव लागू किया',
  'activity.user.deleted': '{actor} ने {name} का खाता हटाया',
  'activity.user.restored': '{actor} ने {name} का खाता पुनर्स्थापित किया',
  'activity.user.password_reset': '{actor} ने {name} का पासवर्ड रीसेट किया',
  'activity.user.password_changed': '{actor} ने अपना पासवर्ड बदला',
  'activity.user.password_revealed': '{actor} ने {name} का पासवर्ड देखा',
  'activity.setting.updated': '{actor} ने सेटिंग {name} बदली',
  'activity.user.sign_in': '{actor} ने साइन इन किया',
  'activity.user.sign_in_failed': '{name} के लिए साइन-इन प्रयास विफल रहा',
  'activity.party.created': '{actor} ने पार्टी {name} जोड़ी',
  'activity.party.updated': '{actor} ने पार्टी {name} को अपडेट किया',
  'activity.product.created': '{actor} ने उत्पाद {name} जोड़ा',
  'activity.product.updated': '{actor} ने उत्पाद {name} को अपडेट किया',
  'activity.role.created': '{actor} ने भूमिका {name} बनाई',
  'activity.role.updated': '{actor} ने भूमिका {name} को अपडेट किया',
  'activity.role.deleted': '{actor} ने भूमिका {name} हटाई',
  'activity.role.restored': '{actor} ने भूमिका {name} पुनर्स्थापित की',
  'activity.order.created': '{actor} ने यह ऑर्डर बनाया',
  'activity.order.dispatched': '{actor} ने यह ऑर्डर भेजा',
  'activity.api_key.created': '{actor} ने API कुंजी {name} जारी की',
  'activity.api_key.revoked': '{actor} ने API कुंजी {name} रद्द की',
  'activity.connector.created': '{actor} ने कनेक्शन {name} जोड़ा',
  'activity.connector.updated': '{actor} ने कनेक्शन {name} बदला',
  'activity.connector.deleted': '{actor} ने कनेक्शन {name} हटाया',
  'activity.connector.ran': '{actor} ने कनेक्शन {name} चलाया',
  'activity.catalog.imported': '{actor} ने {fileName} से {count} उत्पाद आयात किए',
  'activity.catalog.reloaded': '{actor} ने उत्पाद कैटलॉग फिर से लोड किया',
  'activity.office_panel.created': '{actor} ने ऑफ़िस पैनल {name} जोड़ा',
  'activity.office_panel.updated': '{actor} ने ऑफ़िस पैनल {name} को अपडेट किया',
  'activity.lead.created': '{actor} ने यह लीड बनाई',
  'activity.lead.updated': '{actor} ने यह लीड अपडेट की',
  'activity.lead.stage_changed': '{actor} ने इस लीड को {to} में ले जाया',
  'activity.lead.deleted': '{actor} ने यह लीड हटाई',
  'activity.lead.restored': '{actor} ने यह लीड पुनर्स्थापित की',
  'activity.order.updated': '{actor} ने यह ऑर्डर अपडेट किया',
  'activity.order.stage_changed': '{actor} ने इस ऑर्डर को {to} में ले जाया',
  'activity.order.deleted': '{actor} ने यह ऑर्डर हटाया',
  'activity.order.restored': '{actor} ने यह ऑर्डर पुनर्स्थापित किया',
  'activity.party.deleted': '{actor} ने पार्टी {name} हटाई',
  'activity.party.restored': '{actor} ने पार्टी {name} पुनर्स्थापित की',
  'activity.party.access_changed': '{actor} ने बदला कि पार्टी {name} तक किसकी पहुँच है',
  'activity.party.variant_saved': '{actor} ने पार्टी {name} के लिए {product} का पार्टी-वार रिकॉर्ड सहेजा',
  'activity.product.deleted': '{actor} ने उत्पाद {name} हटाया',
  'activity.product.restored': '{actor} ने उत्पाद {name} पुनर्स्थापित किया',
  'activity.product_category.created': '{actor} ने कैटलॉग में उत्पाद {name} जोड़ा',
  'activity.product_category.updated': '{actor} ने कैटलॉग में उत्पाद {name} बदला',
  'activity.product_category.deleted': '{actor} ने कैटलॉग से उत्पाद {name} हटाया',
  'activity.product_category.restored': '{actor} ने उत्पाद {name} को कैटलॉग में वापस रखा',
  'activity.option_list_item.created': '{actor} ने विकल्प {name} जोड़ा',
  'activity.option_list_item.updated': '{actor} ने विकल्प {name} को अपडेट किया',
  'activity.option_list_item.deleted': '{actor} ने विकल्प {name} हटाया',
  'activity.option_list_item.restored': '{actor} ने विकल्प {name} पुनर्स्थापित किया',
  'activity.option_list_item.reordered': '{actor} ने {list} को पुनः क्रमित किया',
  'activity.custom_field_definition.created': '{actor} ने कस्टम फ़ील्ड {name} जोड़ी',
  'activity.custom_field_definition.updated': '{actor} ने कस्टम फ़ील्ड {name} को अपडेट किया',
  'activity.custom_field_definition.deleted': '{actor} ने कस्टम फ़ील्ड {name} हटाई',
  'activity.custom_field_definition.restored': '{actor} ने कस्टम फ़ील्ड {name} पुनर्स्थापित की',
  'activity.custom_field_definition.reordered':
    '{actor} ने {entity} के कस्टम फ़ील्ड पुनः क्रमित किए',
  'activity.product_image.created': '{actor} ने {name} में एक फ़ोटो जोड़ी',
  'activity.product_image.updated': '{actor} ने {name} पर एक फ़ोटो अपडेट की',
  'activity.product_image.deleted': '{actor} ने {name} से एक फ़ोटो हटाई',
  'activity.pipeline_stage.updated': '{actor} ने चरण {name} को अपडेट किया',
  'activity.pipeline_stage.reordered': '{actor} ने {pipeline} के चरण पुनः क्रमित किए',
  'activity.pipeline_stage.archived': '{actor} ने चरण {name} को संग्रहीत किया',
  'activity.pipeline_stage.restored': '{actor} ने चरण {name} को पुनर्स्थापित किया',
  'activity.pipeline_stage.default_changed': '{actor} ने {name} को डिफ़ॉल्ट चरण बनाया',
  'activity.activity_log.verified': '{actor} ने ऑडिट श्रृंखला सत्यापित की',
  'activity.activity_log.exported': '{actor} ने गतिविधि लॉग निर्यात किया',
  'activity.report.exported': '{actor} ने {report} रिपोर्ट निर्यात की',
  'activity.document_template.created': '{actor} ने दस्तावेज़ टेम्पलेट {name} बनाया',
  'activity.document_template.updated': '{actor} ने दस्तावेज़ टेम्पलेट {name} अपडेट किया',
  'activity.document_template.deleted': '{actor} ने दस्तावेज़ टेम्पलेट {name} हटाया',
  'activity.document_template.restored': '{actor} ने दस्तावेज़ टेम्पलेट {name} पुनर्स्थापित किया',
  'activity.document_export.rendered': '{actor} ने {subject} के लिए {documentType} बनाया',

  'common.save': 'सहेजें',
  'common.cancel': 'रद्द करें',
  'common.edit': 'Edit',
  'common.close': 'Close',
  'modal.close': 'बंद करें',
  'modal.expand': 'पूरी चौड़ाई में खोलें',
  'modal.shrink': 'छोटा करें',
  'common.delete': 'हटाएँ',
  'common.older': 'पुराने',
  'common.newer': 'नए',
  'common.copy': 'कॉपी करें',
  'common.loadMore': 'और लोड करें',
  'common.noMatches': 'कोई मेल नहीं',
  'common.working': 'काम हो रहा है',

  'count.leads.one': '{count} लीड',
  'count.leads.other': '{count} लीड',
  'count.rows.one': '{count} पंक्ति',
  'count.rows.other': '{count} पंक्तियाँ',
  // TODO(i18n-hi)
  'validation.avatar.fileRequired': 'Choose a picture',
  // TODO(i18n-hi)
  'validation.avatar.tooLarge': 'A profile picture must be 5 MB or smaller',
  // TODO(i18n-hi)
  'validation.avatar.unreadable': 'That file could not be read as a picture',
  'activity.user.avatar_set': '{actor} ने {name} के लिए प्रोफ़ाइल फ़ोटो लगाई',
  'activity.user.avatar_cleared': '{actor} ने {name} की प्रोफ़ाइल फ़ोटो हटाई',
  // TODO(i18n-hi)
  'access.editor.backToList': 'Roles & users',
  'access.error.load': 'लोग और भूमिकाएँ लोड नहीं हो सकीं',
  // TODO(i18n-hi)
  'access.permissions.blocked': 'Needs the {tier} tier. Change the tier above to enable it.',
  // TODO(i18n-hi)
  'access.permissions.clearAll': 'Clear all',
  // TODO(i18n-hi)
  'access.permissions.module': 'Module',
  // TODO(i18n-hi)
  'access.permissions.modules': 'Modules',
  // TODO(i18n-hi)
  'access.permissions.notApplicable': 'This module has no such action — it cannot exist.',
  // TODO(i18n-hi)
  'access.permissions.selectAll': 'Select all',
  // TODO(i18n-hi)
  'access.permissions.tally': 'Held',
  // TODO(i18n-hi)
  'access.permissions.toggleColumn': 'Turn {action} on or off for every module',
  // TODO(i18n-hi)
  'access.permissions.toggleRow': 'Turn every action on or off for {module}',
  // TODO(i18n-hi)
  'access.recycleBin.empty': 'Nothing has been deleted.',
  // TODO(i18n-hi)
  'access.recycleBin.hide': 'Hide deleted roles and people',
  // TODO(i18n-hi)
  'access.recycleBin.loading': 'Loading…',
  'access.recycleBin.loadFailed': 'हटाई गई भूमिकाएँ और लोग लोड नहीं हो सके',
  // TODO(i18n-hi)
  'access.recycleBin.restore': 'Restore',
  // TODO(i18n-hi)
  'access.recycleBin.restoreRoleFailed': 'Could not restore the role',
  // TODO(i18n-hi)
  'access.recycleBin.restoreUserFailed': 'Could not restore the person',
  // TODO(i18n-hi)
  'access.recycleBin.roleMeta': 'role · {tier}',
  // TODO(i18n-hi)
  'access.recycleBin.show': 'Show deleted roles and people',
  // TODO(i18n-hi)
  'access.recycleBin.userMeta': 'person · {username}',
  // TODO(i18n-hi)
  'access.roleEditor.cancel': 'Cancel',
  // TODO(i18n-hi)
  'access.roleEditor.changeTier': 'Change to {tier}',
  // TODO(i18n-hi)
  'access.roleEditor.diffNone': 'none',
  // TODO(i18n-hi)
  'access.roleEditor.diffNotSet': 'not set',
  // TODO(i18n-hi)
  'access.roleEditor.diffPermissionsCount': '{count} permission{plural}',
  // TODO(i18n-hi)
  'access.roleEditor.discardConfirm': 'Discard your unsaved changes to this role?',
  // TODO(i18n-hi)
  'access.roleEditor.keepTier': 'Keep {tier}',
  // TODO(i18n-hi)
  'access.roleEditor.nameLabel': 'Name',
  // TODO(i18n-hi)
  'access.roleEditor.newRole': 'New role',
  // TODO(i18n-hi)
  'access.roleEditor.overwriteMine': 'Overwrite with mine',
  // TODO(i18n-hi)
  'access.roleEditor.pendingWarning': 'Changing to {tier} will remove {count} permission{plural}:',
  // TODO(i18n-hi)
  'access.roleEditor.reloadTheirs': 'Reload theirs',
  // TODO(i18n-hi)
  'access.roleEditor.save': 'Save',
  // TODO(i18n-hi)
  'access.roleEditor.saveFailedDefault': 'Could not save the role',
  // TODO(i18n-hi)
  'access.roleEditor.saving': 'Saving…',
  // TODO(i18n-hi)
  'access.roleEditor.theirs': 'theirs',
  // TODO(i18n-hi)
  'access.roleEditor.tierLabel': 'Tier',
  // TODO(i18n-hi)
  'access.roleEditor.tierLocked': 'A system role’s tier is locked',
  // TODO(i18n-hi)
  'access.roleEditor.yours': 'yours',
  // TODO(i18n-hi)
  'access.roles.cancel': 'Cancel',
  // TODO(i18n-hi)
  'access.roles.colPermissions': 'Permissions',
  // TODO(i18n-hi)
  'access.roles.colRole': 'Role',
  // TODO(i18n-hi)
  'access.roles.colTier': 'Tier',
  // TODO(i18n-hi)
  'access.roles.colUsers': 'Users',
  // TODO(i18n-hi)
  'access.roles.create': 'Create role',
  // TODO(i18n-hi)
  'access.roles.delete': 'Delete',
  // TODO(i18n-hi)
  'access.roles.deleteBlocked': 'Still assigned to somebody — move them first',
  // TODO(i18n-hi)
  'access.roles.deleteConfirmBody':
    'It goes to the Recycle Bin and can be restored, and anybody who still holds it reattaches when it comes back.',
  // TODO(i18n-hi)
  'access.roles.deleteConfirmTitle': 'Delete the "{name}" role?',
  // TODO(i18n-hi)
  'access.roles.deleteFailed': 'Could not delete',
  // TODO(i18n-hi)
  'access.roles.detail.created': 'Created',
  // TODO(i18n-hi)
  'access.roles.detail.grants': 'What this role grants',
  // TODO(i18n-hi)
  'access.roles.detail.grantsCount': '{held} of {total} permissions granted',
  // TODO(i18n-hi)
  'access.roles.detail.grantsNone': 'Nothing yet — this role grants no permissions.',
  // TODO(i18n-hi)
  'access.roles.detail.grantsUnknown': 'Not in the catalogue',
  // TODO(i18n-hi)
  'access.roles.detail.id': 'Role ID',
  // TODO(i18n-hi)
  'access.roles.detail.metaCounts': '{permissions} permissions · {users} people',
  // TODO(i18n-hi)
  'access.roles.detail.no': 'No',
  // TODO(i18n-hi)
  'access.roles.detail.summary': 'Summary',
  // TODO(i18n-hi)
  'access.roles.detail.system': 'System role',
  // TODO(i18n-hi)
  'access.roles.detail.updated': 'Last changed',
  // TODO(i18n-hi)
  'access.roles.detail.version': 'Record version',
  // TODO(i18n-hi)
  'access.roles.detail.yes': 'Yes',
  // TODO(i18n-hi)
  'access.roles.edit': 'Edit',
  // TODO(i18n-hi)
  'access.roles.empty': 'No roles yet. The Administrator role was created with this company.',
  // TODO(i18n-hi)
  'access.roles.open': 'Open',
  // TODO(i18n-hi)
  'access.roles.systemBadge': 'system',
  // TODO(i18n-hi)
  'access.roles.title': '{count} roles',
  // TODO(i18n-hi)
  'access.roles.titleLoading': 'Roles',
  // TODO(i18n-hi)
  'access.secret.copied': 'Copied',
  // TODO(i18n-hi)
  'access.secret.copy': 'Copy',
  // TODO(i18n-hi)
  'access.secret.done': 'Done',
  // TODO(i18n-hi)
  'access.secret.helper': 'इसे अभी कॉपी करके सौंप दें। यह स्क्रीन इसे दोबारा नहीं दिखाएगी।',
  // TODO(i18n-hi)
  'access.secret.title': 'Temporary password for {username}',
  // TODO(i18n-hi)
  'access.tab.roles': 'Roles',
  // TODO(i18n-hi)
  'access.tab.users': 'Users',
  // TODO(i18n-hi)
  'access.userEdit.cancel': 'Cancel',
  // TODO(i18n-hi)
  'access.userEdit.displayName': 'Display name',
  // TODO(i18n-hi)
  'access.userEdit.save': 'Save',
  // TODO(i18n-hi)
  'access.userEdit.saveFailed': 'Could not save',
  // TODO(i18n-hi)
  'access.userEdit.username': 'Username',
  // TODO(i18n-hi)
  'access.userForm.cancel': 'Cancel',
  // TODO(i18n-hi)
  'access.userForm.create': 'Create user',
  // TODO(i18n-hi)
  'access.userForm.createFailed': 'Could not create the user',
  // TODO(i18n-hi)
  'access.userForm.displayName': 'Display name',
  // TODO(i18n-hi)
  'access.userForm.helper':
    'A temporary password is generated and shown once. There is no way to see it again.',
  // TODO(i18n-hi)
  'access.userForm.role': 'Role',
  // TODO(i18n-hi)
  'access.userForm.username': 'Username',
  // TODO(i18n-hi)
  'access.users.activate': 'Activate',
  // TODO(i18n-hi)
  'access.users.add': 'Add user',
  // TODO(i18n-hi)
  'access.users.cancel': 'Cancel',
  // TODO(i18n-hi)
  'access.users.colId': 'ID',
  // TODO(i18n-hi)
  'access.users.colLastSignIn': 'Last sign-in',
  // TODO(i18n-hi)
  'access.users.colName': 'Name',
  // TODO(i18n-hi)
  'access.users.colRole': 'Role',
  // TODO(i18n-hi)
  'access.users.colStatus': 'Status',
  // TODO(i18n-hi)
  'access.users.colUsername': 'Username',
  // TODO(i18n-hi)
  'access.users.deactivate': 'Deactivate',
  // TODO(i18n-hi)
  'access.users.deactivateConfirmBody':
    '{name} will not be able to sign in. Their leads, orders and audit history are unchanged. This is not a delete — use Delete to send them to the Recycle Bin.',
  // TODO(i18n-hi)
  'access.users.deactivateConfirmTitle': 'Deactivate {name}?',
  // TODO(i18n-hi)
  'access.users.delete': 'Delete',
  // TODO(i18n-hi)
  'access.users.deleteConfirmBody':
    'They go to the Recycle Bin and can be restored. Their records and audit history stay exactly as they are.',
  // TODO(i18n-hi)
  'access.users.deleteConfirmTitle': 'Delete {name}?',
  // TODO(i18n-hi)
  'access.users.deleteFailed': 'Could not delete',
  // TODO(i18n-hi)
  'access.users.detail.access': 'Access',
  // TODO(i18n-hi)
  'access.users.detail.activity': 'Activity',
  // TODO(i18n-hi)
  'access.users.detail.created': 'Added',
  // TODO(i18n-hi)
  'access.users.detail.identity': 'Identity',
  // TODO(i18n-hi)
  'access.users.detail.updated': 'Last changed',
  // TODO(i18n-hi)
  'access.users.detail.version': 'Record version',
  // TODO(i18n-hi)
  'access.users.edit': 'Edit',
  // TODO(i18n-hi)
  'access.users.empty': 'Nobody here yet.',
  // TODO(i18n-hi)
  'access.users.emptyFiltered': 'Nobody matches those filters.',
  // TODO(i18n-hi)
  'access.users.filterRoleAll': 'All roles',
  // TODO(i18n-hi)
  'access.users.filterRoleLabel': 'Filter by role',
  // TODO(i18n-hi)
  'access.users.filterStatusActive': 'Active',
  // TODO(i18n-hi)
  'access.users.filterStatusInactive': 'Inactive',
  // TODO(i18n-hi)
  'access.users.generateInstead': 'Generate one instead',
  // TODO(i18n-hi)
  'access.users.lastAdminReason': 'At least one active administrator must remain',
  // TODO(i18n-hi)
  'access.users.newPassword': 'New password',
  // TODO(i18n-hi)
  'access.users.newPasswordHint':
    'At least 8 characters. Shown once here, then only its hash is kept.',
  // TODO(i18n-hi)
  'access.users.open': 'Open',
  // TODO(i18n-hi)
  'access.users.resetPassword': 'Reset password',
  'access.users.revealPassword': 'पासवर्ड दिखाएँ',
  'access.users.revealPasswordTitle': '{name} का पासवर्ड दिखाएँ',
  'access.users.revealPasswordSubtitle':
    'जारी रखने के लिए अपना पासवर्ड टाइप करें। इसका हर उपयोग गतिविधि लॉग में स्थायी रूप से दर्ज होता है।',
  'access.users.revealPasswordConfirm': 'आपका पासवर्ड',
  'access.users.revealPasswordConfirmHint': 'वही जिससे आपने साइन इन किया।',
  'access.users.revealPasswordFailed': 'वह पासवर्ड दिखाया नहीं जा सका',
  'access.users.reveal': 'दिखाएँ',
  // TODO(i18n-hi)
  'access.users.resetPasswordFailed': 'Could not reset the password',
  // TODO(i18n-hi)
  'access.users.roleChangeFailed': 'Could not change the role',
  // TODO(i18n-hi)
  'access.users.roleHint':
    'Saved as soon as you choose. Everything this person may do comes from their role.',
  // TODO(i18n-hi)
  'access.users.searchLabel': 'Search people',
  // TODO(i18n-hi)
  'access.users.searchPlaceholder': 'Search name or username…',
  // TODO(i18n-hi)
  'access.users.setPassword': 'Set password',
  // TODO(i18n-hi)
  'access.users.setPasswordSubtitle':
    'किसी को उनका पासवर्ड बताने का तरीका यही है कि आप एक ज्ञात पासवर्ड सेट करें। संग्रहीत हैश को कभी उलटा नहीं जाता।',
  // TODO(i18n-hi)
  'access.users.setPasswordTitle': 'Set a password for {name}',
  // TODO(i18n-hi)
  'access.users.sortCreated': 'Creation order',
  // TODO(i18n-hi)
  'access.users.sortLabel': 'Sort by',
  // TODO(i18n-hi)
  'access.users.sortLastSignIn': 'Last sign-in',
  // TODO(i18n-hi)
  'access.users.sortName': 'Name',
  // TODO(i18n-hi)
  'access.users.sortRole': 'Role',
  // TODO(i18n-hi)
  'access.users.statusActive': 'Active',
  // TODO(i18n-hi)
  'access.users.statusChangeFailed': 'Could not change the status',
  // TODO(i18n-hi)
  'access.users.statusInactive': 'Inactive',
  // TODO(i18n-hi)
  'access.users.thisIsYou': 'This is you',
  // TODO(i18n-hi)
  'access.users.title': '{count} people',
  // TODO(i18n-hi)
  'access.users.titleLoading': 'People',
  // TODO(i18n-hi)
  'action.cancel': 'Cancel',
  // TODO(i18n-hi)
  'action.close': 'Close',
  // TODO(i18n-hi)
  'action.dismiss': 'Dismiss',
  'toast.dismiss': 'बंद करें',
  // TODO(i18n-hi)
  'action.done': 'Done',
  // TODO(i18n-hi)
  'action.newLead': 'New lead',
  'action.retryNow': 'अभी फिर कोशिश करें',
  // TODO(i18n-hi)
  'action.reviewConflicts': 'Review conflicts',
  // TODO(i18n-hi)
  'action.signOut': 'Sign out',
  // TODO(i18n-hi)
  'app.name': 'OrderBook',
  // TODO(i18n-hi)
  'avatar.change': 'Change picture',
  // TODO(i18n-hi)
  'avatar.choose': 'Choose a picture',
  // TODO(i18n-hi)
  'avatar.error.notAnImage': 'That file is not a picture.',
  // TODO(i18n-hi)
  'avatar.error.removeFailed': 'Could not remove the picture',
  // TODO(i18n-hi)
  'avatar.error.tooLarge': 'A profile picture must be 5 MB or smaller.',
  // TODO(i18n-hi)
  'avatar.error.uploadFailed': 'Could not save the picture',
  // TODO(i18n-hi)
  'avatar.hint': 'Squared and resized to {px} px on save. JPEG, PNG or WebP, up to {max}.',
  // TODO(i18n-hi)
  'avatar.remove': 'Remove',
  // TODO(i18n-hi)
  'avatar.section': 'Profile picture',
  // TODO(i18n-hi)
  'backup.export.action': 'Export data…',
  // TODO(i18n-hi)
  'backup.export.confirm': 'Export',
  // TODO(i18n-hi)
  'backup.export.done': 'Export ready — check your downloads',
  'backup.export.failed': 'निर्यात विफल रहा',
  // TODO(i18n-hi)
  'backup.export.passphraseHint':
    'At least 10 characters. This passphrase is never stored anywhere — if it is lost, this file cannot be opened again.',
  // TODO(i18n-hi)
  'backup.export.passphraseLabel': 'Export passphrase',
  // TODO(i18n-hi)
  'backup.export.scopeFullReplica': 'Full device replica',
  // TODO(i18n-hi)
  'backup.export.scopeLabel': 'What to export',
  // TODO(i18n-hi)
  'backup.export.scopeSettingsOnly': 'Local settings only',
  // TODO(i18n-hi)
  'backup.restore.action': 'Restore from backup…',
  // TODO(i18n-hi)
  'backup.restore.cancel': 'Cancel',
  // TODO(i18n-hi)
  'backup.restore.chooseFile': 'Choose backup file…',
  // TODO(i18n-hi)
  'backup.restore.confirm': 'Restore',
  // TODO(i18n-hi)
  'backup.restore.confirmWipeInput': 'Type CONFIRM',
  // TODO(i18n-hi)
  'backup.restore.donePairAgain':
    'This device has been restored. It will now reload and ask you to pair again.',
  'backup.restore.failed': 'पुनर्स्थापना विफल रही',
  // TODO(i18n-hi)
  'backup.restore.newPairingPassword':
    'New pairing password (shown once): {password}. Every Office Panel must re-pair using it.',
  // TODO(i18n-hi)
  'backup.restore.passphraseLabel': 'Backup passphrase',
  'backup.restore.readFailed': 'वह फ़ाइल पढ़ी नहीं जा सकी',
  // TODO(i18n-hi)
  'backup.restore.title': 'Restore from backup',
  // TODO(i18n-hi)
  'catalog.filter.all': 'All',
  // TODO(i18n-hi)
  'catalog.parties.column.access': 'My access',
  // TODO(i18n-hi)
  'catalog.parties.column.city': 'City',
  // TODO(i18n-hi)
  'catalog.parties.column.code': 'Code',
  // TODO(i18n-hi)
  'catalog.parties.column.name': 'Name',
  // TODO(i18n-hi)
  'catalog.parties.column.phone': 'Phone',
  // TODO(i18n-hi)
  'catalog.parties.column.variants': 'Products',
  // TODO(i18n-hi)
  'catalog.parties.created': '{name} saved — syncs when the Master is reachable',
  // TODO(i18n-hi)
  'catalog.parties.empty.description': 'Parties you create appear here, online or off.',
  // TODO(i18n-hi)
  'catalog.parties.empty.filtered': 'No parties match this search.',
  // TODO(i18n-hi)
  'catalog.parties.empty.title': 'No parties yet',
  // TODO(i18n-hi)
  'catalog.parties.new': 'New party',
  // TODO(i18n-hi)
  'catalog.parties.notSynced': 'not synced',
  // TODO(i18n-hi)
  'catalog.parties.searchLabel': 'Search parties',
  // TODO(i18n-hi)
  'catalog.parties.searchPlaceholder': 'Search name, code, phone…',
  'catalog.products.column.name': 'उप-उत्पाद',
  // TODO(i18n-hi)
  'catalog.products.column.size': 'Size',
  'catalog.products.column.colours': 'रंग',
  'product.multiColour.pill': 'कोई भी रंग',
  // TODO(i18n-hi)
  'catalog.products.created': '{name} saved — syncs when the Master is reachable',
  'catalog.products.empty.description': 'आपके बनाए उप-उत्पाद यहाँ दिखते हैं, ऑनलाइन हों या ऑफ़लाइन।',
  'catalog.products.empty.filtered': 'इन फ़िल्टरों से कोई उप-उत्पाद मेल नहीं खाता।',
  'catalog.products.empty.title': 'अभी कोई उप-उत्पाद नहीं',
  'catalog.products.new': 'नया उप-उत्पाद',
  'catalog.products.searchLabel': 'उप-उत्पाद खोजें',
  'catalog.products.searchPlaceholder': 'उप-उत्पाद, कोड, ब्रांड या उत्पाद खोजें…',
  'catalog.products.import': 'आयात करें',
  'catalog.products.loadMore': 'और दिखाएँ',
  'catalog.products.shown': '{total} में से {shown} दिखाए जा रहे हैं',
  'catalog.products.cachedPage': 'कैश किया पृष्ठ — मास्टर पैनल पहुँच से बाहर है',
  'catalog.products.loadFailed': 'कैटलॉग लोड नहीं हो सका',
  // --- Catalogue v2 (docs/catalogue/CATALOGUE_MODEL.md): brand, product, sub product ---
  'catalog.nav.subProducts': 'उप-उत्पाद',
  'catalog.nav.mainProducts': 'उत्पाद',
  'catalog.nav.brands': 'ब्रांड',
  'catalog.products.column.brand': 'ब्रांड',
  'catalog.products.column.stock': 'स्टॉक',
  'catalog.products.productFilter': 'उत्पाद से छाँटें',
  'catalog.products.allProducts': 'सभी उत्पाद',
  'catalog.colourRule.multicolour': 'बहुरंगी',
  'catalog.mainProducts.searchLabel': 'उत्पाद खोजें',
  'catalog.mainProducts.searchPlaceholder': 'कोड, नाम या ब्रांड खोजें…',
  'catalog.mainProducts.new': 'नया उत्पाद',
  'catalog.mainProducts.new.title': 'नया उत्पाद',
  'catalog.mainProducts.edit.title': 'उत्पाद संपादित करें',
  'catalog.mainProducts.created': '{name} जोड़ा गया',
  'catalog.mainProducts.updated': '{name} अपडेट किया गया',
  'catalog.mainProducts.deleted': '{name} रीसायकल बिन में भेजा गया',
  'catalog.mainProducts.saveFailed': 'उत्पाद सहेजा नहीं जा सका',
  'catalog.mainProducts.deleteFailed': 'उत्पाद हटाया नहीं जा सका',
  'catalog.mainProducts.loadFailed': 'उत्पाद लोड नहीं हो सके',
  'catalog.mainProducts.codeInvalid': 'केवल अक्षरों और अंकों वाला कोड लिखें, जैसे OPT',
  'catalog.mainProducts.nameRequired': 'उत्पाद का नाम लिखें',
  'catalog.mainProducts.delete.title': '{name} हटाएँ?',
  'catalog.mainProducts.delete.body':
    'यह रीसायकल बिन में जाएगा, जहाँ से इसे वापस लाया जा सकता है। जिस उत्पाद में अभी उप-उत्पाद हैं उसे हटाया नहीं जा सकता — पहले उन्हें दूसरे उत्पाद में ले जाएँ या हटाएँ।',
  'catalog.mainProducts.field.code': 'कोड',
  'catalog.mainProducts.field.codeHint':
    'केवल अक्षर और अंक, जैसे OPT। कर्मचारी नाम की जगह इसे टाइप कर सकते हैं।',
  'catalog.mainProducts.field.name': 'नाम',
  'catalog.mainProducts.field.brand': 'ब्रांड',
  'catalog.mainProducts.field.noBrand': 'कोई ब्रांड नहीं',
  'catalog.mainProducts.field.sortOrder': 'कैटलॉग क्रम',
  'catalog.mainProducts.field.sortOrderHint':
    '1 सबसे पहले आता है। बिना संख्या वाला उत्पाद संख्या वाले उत्पादों के बाद आता है।',
  'catalog.mainProducts.column.code': 'कोड',
  'catalog.mainProducts.column.name': 'उत्पाद',
  'catalog.mainProducts.column.subProducts': 'उप-उत्पाद',
  'catalog.mainProducts.column.sortOrder': 'क्रम',
  'catalog.mainProducts.detail.subProducts': 'उप-उत्पाद ({count})',
  'catalog.mainProducts.detail.none': 'इस उत्पाद में अभी कोई उप-उत्पाद नहीं है।',
  'catalog.mainProducts.empty.title': 'अभी कोई उत्पाद नहीं',
  'catalog.mainProducts.empty.description':
    'एक उत्पाद उप-उत्पादों को एक कोड और ब्रांड के अंतर्गत रखता है — जैसे OPT, वन पीस टॉयलेट।',
  'catalog.mainProducts.empty.filtered': 'इन फ़िल्टरों से कोई उत्पाद मेल नहीं खाता।',
  'catalog.brands.noAccess.title': 'ब्रांड आपकी भूमिका में शामिल नहीं हैं',
  'catalog.brands.noAccess.description': 'किसी प्रशासक से {permission} माँगें।',
  'product.field.brand': 'ब्रांड',
  'product.field.brandHint': 'यह उत्पाद से आता है। इसे उत्पाद पृष्ठ पर बदलें।',
  'product.detail.colour': 'रंग',
  // TODO(i18n-hi)
  'common.no': 'No',
  // TODO(i18n-hi)
  'common.yes': 'Yes',
  // TODO(i18n-hi)
  'conflicts.action.keepWinner': 'Keep what is there',
  // TODO(i18n-hi)
  'conflicts.action.restoreLoser': 'Put the other value back',
  // TODO(i18n-hi)
  'conflicts.description':
    'Raised when two panels edited the same field of the same record while both were offline. The higher timestamp won; the other value is kept here so nothing is lost silently.',
  // TODO(i18n-hi)
  'conflicts.empty.description':
    'Conflicts appear here when two panels edit the same field of the same record while both are offline.',
  // TODO(i18n-hi)
  'conflicts.empty.title': 'No conflicts',
  // TODO(i18n-hi)
  'conflicts.empty.value': '(empty)',
  // TODO(i18n-hi)
  'conflicts.emptyValue': '(empty)',
  // TODO(i18n-hi)
  'conflicts.error.load': 'Could not load conflicts',
  // TODO(i18n-hi)
  'conflicts.error.resolve': 'Could not resolve the conflict',
  // TODO(i18n-hi)
  'conflicts.includeReviewed': 'Include reviewed',
  // TODO(i18n-hi)
  'conflicts.kept': 'Kept (device {device})',
  // TODO(i18n-hi)
  'conflicts.noPermission': 'Your role does not include {permission}.',
  // TODO(i18n-hi)
  'conflicts.overwritten': 'Overwritten (device {device})',
  // TODO(i18n-hi)
  'conflicts.resolveErrorFallback': 'Could not resolve the conflict',
  // TODO(i18n-hi)
  'conflicts.reviewedAt': 'Reviewed {when}',
  // TODO(i18n-hi)
  'connection.auto.connect': 'Proceed with Auto Connection',
  // TODO(i18n-hi)
  'connection.auto.connecting': 'Searching…',
  // TODO(i18n-hi)
  'connection.auto.scanOnly': 'Search only',
  // TODO(i18n-hi)
  'connection.auto.step1':
    'On the Master Panel PC, open “Office Panels” and press “Add Office Panel”.',
  // TODO(i18n-hi)
  'connection.auto.step2': 'It will say “Waiting for office panel…”.',
  // TODO(i18n-hi)
  'connection.auto.step3': 'Press the button below. The two will find each other automatically.',
  // TODO(i18n-hi)
  'connection.auto.title': 'Auto connection (recommended)',
  // TODO(i18n-hi)
  'connection.errorFallback': 'Connection failed',
  // TODO(i18n-hi)
  'connection.manual.address': 'Master address',
  // TODO(i18n-hi)
  'connection.manual.connect': 'Connect',
  // TODO(i18n-hi)
  'connection.manual.connecting': 'Connecting…',
  // TODO(i18n-hi)
  'connection.manual.hint':
    'Use the address and pairing password shown on the Master Panel’s setup screen.',
  // TODO(i18n-hi)
  'connection.manual.password': 'Pairing password',
  // TODO(i18n-hi)
  'connection.manual.port': 'Port',
  // TODO(i18n-hi)
  'connection.manual.title': 'Manual connection',
  // TODO(i18n-hi)
  'connection.mode.auto': 'Auto connection',
  // TODO(i18n-hi)
  'connection.mode.manual': 'Manual connection',
  // TODO(i18n-hi)
  'connection.panelName': 'Name for this PC',
  // TODO(i18n-hi)
  'connection.scan.acceptingNo': 'Not right now',
  // TODO(i18n-hi)
  'connection.scan.acceptingYes': 'Yes',
  // TODO(i18n-hi)
  'connection.scan.col.accepting': 'Accepting',
  // TODO(i18n-hi)
  'connection.scan.col.address': 'Address',
  // TODO(i18n-hi)
  'connection.scan.col.master': 'Master',
  // TODO(i18n-hi)
  'connection.scan.defaultName': 'Master Panel',
  // TODO(i18n-hi)
  'connection.scan.none.description':
    'Check that the Master PC is switched on and on the same network.',
  // TODO(i18n-hi)
  'connection.scan.none.title': 'No Master Panel answered',
  // TODO(i18n-hi)
  'connection.scanErrorFallback': 'Could not search the network',
  // TODO(i18n-hi)
  'connection.status.connected': 'Connected to network',
  // TODO(i18n-hi)
  'connection.status.disconnected': 'Not connected to any network',
  // TODO(i18n-hi)
  'connection.status.hint':
    'Plug in the LAN cable or join the shop WiFi, then this screen will update.',
  // TODO(i18n-hi)
  'connection.status.thisPc': 'This PC: {addresses}',
  // TODO(i18n-hi)
  'connection.title': 'Connect to Master Panel',
  // TODO(i18n-hi)
  'crash.body':
    'The panel stopped rather than showing something wrong. Reloading usually gets you back to where you were.',
  // TODO(i18n-hi)
  'crash.copy': 'Copy details',
  // TODO(i18n-hi)
  'crash.reload': 'Reload',
  // TODO(i18n-hi)
  'crash.title': 'Something went wrong on this screen',
  // TODO(i18n-hi)
  'dashboard.dispatched.countOnly': '{count} {unit} dispatched',
  // TODO(i18n-hi)
  'dashboard.dispatched.none': 'Nothing dispatched yet this week',
  // TODO(i18n-hi)
  'dashboard.dispatched.title': 'Dispatched this week',
  // TODO(i18n-hi)
  'dashboard.dispatched.unitMany': 'orders',
  // TODO(i18n-hi)
  'dashboard.dispatched.unitOne': 'order',
  // TODO(i18n-hi)
  'dashboard.empty.description':
    'Once leads, orders or stock exist on this panel, your dashboard fills in.',
  // TODO(i18n-hi)
  'dashboard.empty.title': 'Nothing here yet',
  // TODO(i18n-hi)
  'dashboard.leads.dueToday': '{count} due for follow-up today',
  // TODO(i18n-hi)
  'dashboard.leads.noneDueToday': 'None due today',
  // TODO(i18n-hi)
  'dashboard.leads.title': 'Open leads',
  // TODO(i18n-hi)
  'dashboard.orders.boxesReserved': '{count} boxes reserved',
  // TODO(i18n-hi)
  'dashboard.orders.noneReserved': 'Nothing reserved',
  // TODO(i18n-hi)
  'dashboard.orders.title': 'Open orders',
  // TODO(i18n-hi)
  'dashboard.panels.addressUnknown': 'Unknown address',
  // TODO(i18n-hi)
  'dashboard.panels.deviceLabel': 'device {code}',
  // TODO(i18n-hi)
  'dashboard.panels.empty.description': 'Panels you add appear here, online or off.',
  // TODO(i18n-hi)
  'dashboard.panels.empty.title': 'No office panels yet',
  // TODO(i18n-hi)
  'dashboard.panels.footerNote':
    'A panel that is offline is still taking leads — they arrive here when it reconnects.',
  // TODO(i18n-hi)
  'dashboard.panels.subtitle': '{connected} of {total} online',
  // TODO(i18n-hi)
  'dashboard.stat.conflicts': 'Conflicts to review',
  // TODO(i18n-hi)
  'dashboard.stat.conflicts.noteNone': 'Nothing to review',
  // TODO(i18n-hi)
  'dashboard.stat.conflicts.noteSome': 'Waiting for review',
  // TODO(i18n-hi)
  'dashboard.stat.lowStock': 'Low stock',
  // TODO(i18n-hi)
  'dashboard.stat.lowStock.noteNone': 'All products healthy',
  // TODO(i18n-hi)
  'dashboard.stat.lowStock.noteSome': 'Below reorder level',
  // TODO(i18n-hi)
  'dashboard.stat.panelsOnline': 'Panels online',
  // TODO(i18n-hi)
  'dashboard.stat.panelsOnline.noteAll': 'All panels connected',
  // TODO(i18n-hi)
  'dashboard.stat.panelsOnline.noteNone': 'No panels registered yet',
  // TODO(i18n-hi)
  'dashboard.stat.panelsOnline.noteSome': '{count} unreachable',
  // TODO(i18n-hi)
  'dashboard.stat.pendingSync': 'Pending sync',
  // TODO(i18n-hi)
  'dashboard.stat.pendingSync.note': 'Changes waiting on panels',
  // TODO(i18n-hi)
  'dashboard.sync.allSynced': 'All synced',
  // TODO(i18n-hi)
  'dashboard.sync.allSyncedNote': 'Nothing queued on this machine',
  // TODO(i18n-hi)
  'dashboard.sync.conflictNote': 'Fields resolved while offline — review to keep the right value',
  // TODO(i18n-hi)
  'dashboard.sync.pending': '{count} pending',
  // TODO(i18n-hi)
  'dashboard.sync.pendingNote': 'Queued on this machine — syncs when reachable',
  // TODO(i18n-hi)
  'dashboard.sync.title': 'Sync',
  // TODO(i18n-hi)
  'dashboard.sync.toReview': '{count} to review',
  // TODO(i18n-hi)
  'fields.action.cancel': 'Cancel',
  // TODO(i18n-hi)
  'fields.action.create': 'Create',
  // TODO(i18n-hi)
  'fields.action.edit': 'Edit',
  // TODO(i18n-hi)
  'fields.action.moveDown': 'Move down',
  // TODO(i18n-hi)
  'fields.action.moveUp': 'Move up',
  // TODO(i18n-hi)
  'fields.action.remove': 'Remove',
  // TODO(i18n-hi)
  'fields.action.save': 'Save',
  // TODO(i18n-hi)
  'fields.col.order': 'Order',
  // TODO(i18n-hi)
  'fields.conflict.notSet': 'not set',
  // TODO(i18n-hi)
  'fields.conflict.overwrite': 'Overwrite with mine',
  // TODO(i18n-hi)
  'fields.conflict.reload': 'Reload theirs',
  // TODO(i18n-hi)
  'fields.conflict.theirs': 'theirs',
  // TODO(i18n-hi)
  'fields.conflict.yours': 'yours',
  // TODO(i18n-hi)
  'fields.definitions.add': 'Add custom field',
  // TODO(i18n-hi)
  'fields.definitions.col.key': 'Key',
  // TODO(i18n-hi)
  'fields.definitions.col.label': 'Label',
  // TODO(i18n-hi)
  'fields.definitions.col.options': 'Choices',
  // TODO(i18n-hi)
  'fields.definitions.col.required': 'Required',
  // TODO(i18n-hi)
  'fields.definitions.col.type': 'Type',
  // TODO(i18n-hi)
  'fields.definitions.delete.body':
    'It goes to the Recycle Bin. Answers already stored under “{key}” stay on their records untouched, and adding the field back recovers them.',
  // TODO(i18n-hi)
  'fields.definitions.delete.title': 'Remove “{label}”?',
  // TODO(i18n-hi)
  'fields.definitions.edit.title': 'Edit {label}',
  // TODO(i18n-hi)
  'fields.definitions.empty.description':
    'Add one to collect something this product has no column for.',
  // TODO(i18n-hi)
  'fields.definitions.empty.title': 'No custom fields on {entity} yet',
  // TODO(i18n-hi)
  'fields.definitions.error.description':
    'The definitions could not be read, so nothing is shown — this is not an empty set.',
  // TODO(i18n-hi)
  'fields.definitions.field.active': 'Show this field on records',
  // TODO(i18n-hi)
  'fields.definitions.field.key': 'Key',
  // TODO(i18n-hi)
  'fields.definitions.field.keyHint':
    'What the answer is stored under on the record. Cannot be changed afterwards.',
  // TODO(i18n-hi)
  'fields.definitions.field.keyLocked':
    'The key is where stored answers live — only the label can change.',
  // TODO(i18n-hi)
  'fields.definitions.field.label': 'Label',
  // TODO(i18n-hi)
  'fields.definitions.field.options': 'Choices',
  // TODO(i18n-hi)
  'fields.definitions.field.optionsHint': 'One per line. A choice field needs at least one.',
  // TODO(i18n-hi)
  'fields.definitions.field.required': 'Required',
  // TODO(i18n-hi)
  'fields.definitions.field.requiredHint':
    'A missing answer flags the record incomplete. It never blocks a save.',
  // TODO(i18n-hi)
  'fields.definitions.field.type': 'Type',
  // TODO(i18n-hi)
  'fields.definitions.field.typeLocked': 'The type is fixed once answers can exist.',
  // TODO(i18n-hi)
  'fields.definitions.new.title': 'New {entity} field',
  // TODO(i18n-hi)
  'fields.definitions.requiredNo': '—',
  // TODO(i18n-hi)
  'fields.definitions.requiredYes': 'Required',
  // TODO(i18n-hi)
  'fields.entity.lead': 'Leads',
  // TODO(i18n-hi)
  'fields.entity.order': 'Orders',
  // TODO(i18n-hi)
  'fields.entity.party': 'Parties',
  // TODO(i18n-hi)
  'fields.entity.product': 'Products',
  // TODO(i18n-hi)
  'fields.error.delete': 'Could not remove it',
  // TODO(i18n-hi)
  'fields.error.load': 'Could not load the fields',
  // TODO(i18n-hi)
  'fields.error.reorder': 'Could not save the new order',
  // TODO(i18n-hi)
  'fields.error.save': 'Could not save',
  // TODO(i18n-hi)
  'fields.error.title': 'Could not load',
  // TODO(i18n-hi)
  'fields.noAccess.description': 'Ask an administrator for {permission}.',
  // TODO(i18n-hi)
  'fields.noAccess.title': 'Fields are not part of your role',
  // TODO(i18n-hi)
  'fields.readOnly': 'You can read these lists but not change them — that needs {permission}.',
  // TODO(i18n-hi)
  'fields.stages.action.archive': 'Archive',
  // TODO(i18n-hi)
  'fields.stages.action.makeDefault': 'Make default',
  // TODO(i18n-hi)
  'fields.stages.action.restore': 'Bring back',
  // TODO(i18n-hi)
  'fields.stages.col.colour': 'Colour',
  // TODO(i18n-hi)
  'fields.stages.col.flags': 'Behaviour',
  // TODO(i18n-hi)
  'fields.stages.col.name': 'Stage',
  // TODO(i18n-hi)
  'fields.stages.description':
    'Stages are the Kanban columns. Archiving one stops new records landing in it; everything already there keeps rendering.',
  // TODO(i18n-hi)
  'fields.stages.edit.title': 'Edit {name}',
  // TODO(i18n-hi)
  'fields.stages.empty.description': 'Lead and order pipelines are created with the company.',
  // TODO(i18n-hi)
  'fields.stages.empty.pipelines': 'No pipelines on this company',
  // TODO(i18n-hi)
  'fields.stages.empty.title': 'No stages in this pipeline',
  // TODO(i18n-hi)
  'fields.stages.error.description':
    'The pipelines could not be read, so nothing is shown — this is not an empty board.',
  // TODO(i18n-hi)
  'fields.stages.field.colour': 'Colour',
  // TODO(i18n-hi)
  'fields.stages.field.name': 'Name',
  // TODO(i18n-hi)
  'fields.stages.field.terminal': 'Records here are finished',
  // TODO(i18n-hi)
  'fields.stages.field.terminalHint': 'Won, lost or dispatched — nothing further is expected.',
  // TODO(i18n-hi)
  'fields.stages.flag.archived': 'Archived',
  // TODO(i18n-hi)
  'fields.stages.flag.default': 'Default',
  // TODO(i18n-hi)
  'fields.stages.flag.terminal': 'Finished',
  // TODO(i18n-hi)
  'fields.stages.refusal.default':
    'The default stage cannot be archived — new records need somewhere to land. Make another stage the default first.',
  // TODO(i18n-hi)
  'fields.stages.refusal.moveTo': 'The default stage, “{target}”, is where they would normally go.',
  // TODO(i18n-hi)
  'fields.stages.refusal.occupied':
    '“{stage}” still holds {leads} leads and {orders} orders. Move them out and it can be archived.',
  // TODO(i18n-hi)
  'fields.status.active': 'In pickers',
  // TODO(i18n-hi)
  'fields.status.inactive': 'Hidden',
  // TODO(i18n-hi)
  'fields.tab.definitions': 'Custom fields',
  // TODO(i18n-hi)
  'fields.tab.stages': 'Pipeline stages',
  // TODO(i18n-hi)
  'fields.tab.values': 'Option lists',
  // TODO(i18n-hi)
  'fields.title': 'Fields',
  // TODO(i18n-hi)
  'fields.type.boolean': 'Yes / no',
  // TODO(i18n-hi)
  'fields.type.date': 'Date',
  // TODO(i18n-hi)
  'fields.type.number': 'Number',
  // TODO(i18n-hi)
  'fields.type.select': 'Choice',
  // TODO(i18n-hi)
  'fields.type.text': 'Text',
  // TODO(i18n-hi)
  'fields.usedBy.inventory': 'inventory',
  // TODO(i18n-hi)
  'fields.usedBy.label': 'Used by {sources}',
  // TODO(i18n-hi)
  'fields.usedBy.leads': 'leads',
  // TODO(i18n-hi)
  'fields.usedBy.orders': 'orders',
  // TODO(i18n-hi)
  'fields.usedBy.products': 'products',
  // TODO(i18n-hi)
  'fields.values.add': 'Add value',
  // TODO(i18n-hi)
  'fields.values.col.colour': 'Colour',
  // TODO(i18n-hi)
  'fields.values.col.label': 'Label',
  // TODO(i18n-hi)
  'fields.values.col.status': 'Status',
  // TODO(i18n-hi)
  'fields.values.col.usage': 'On records',
  // TODO(i18n-hi)
  'fields.values.col.value': 'Value',
  // TODO(i18n-hi)
  'fields.values.delete.body':
    'It goes to the Recycle Bin and can be restored. Every record already holding “{value}” keeps that exact string — what changes is only that new records are no longer offered it.',
  // TODO(i18n-hi)
  'fields.values.delete.title': 'Remove “{label}”?',
  // TODO(i18n-hi)
  'fields.values.edit.title': 'Edit {label}',
  // TODO(i18n-hi)
  'fields.values.empty.description':
    'Add a value and it becomes a choice everywhere this list is used.',
  // TODO(i18n-hi)
  'fields.values.empty.title': 'Nothing in this list yet',
  // TODO(i18n-hi)
  'fields.values.error.description':
    'The list could not be read, so nothing is shown — this is not an empty list.',
  // TODO(i18n-hi)
  'fields.values.field.active': 'Offer this in pickers',
  // TODO(i18n-hi)
  'fields.values.field.activeHint':
    'Turning this off hides it from new records. Records already holding it keep showing it.',
  // TODO(i18n-hi)
  'fields.values.field.hex': 'Colour',
  // TODO(i18n-hi)
  'fields.values.field.hexHint': 'Six hex digits, e.g. {example}. Leave empty for no swatch.',
  // TODO(i18n-hi)
  'fields.values.field.hexInvalid': 'Use six hex digits after a #, e.g. {example}.',
  // TODO(i18n-hi)
  'fields.values.field.label': 'Label',
  // TODO(i18n-hi)
  'fields.values.field.labelHint': 'What people read. Safe to rename at any time.',
  // TODO(i18n-hi)
  'fields.values.field.value': 'Value',
  // TODO(i18n-hi)
  'fields.values.field.valueHint':
    'What gets written onto the record. Cannot be changed afterwards.',
  // TODO(i18n-hi)
  'fields.values.field.valueLocked':
    'The value is what records already hold — only the label can change.',
  // TODO(i18n-hi)
  'fields.values.new.title': 'New {set} value',
  // TODO(i18n-hi)
  'fields.values.unlisted.description':
    'These strings sit on live records but have no entry here, so nothing offers them for a new record. Add one to put it back in the pickers.',
  // TODO(i18n-hi)
  'fields.values.unlisted.item': '{value} · {count}',
  // TODO(i18n-hi)
  'fields.values.unlisted.title': 'Already on records, not in the list',
  // TODO(i18n-hi)
  'firstRun.choose.back': 'Back',
  // TODO(i18n-hi)
  'firstRun.choose.newSite': 'Set up new site',
  // TODO(i18n-hi)
  'firstRun.dataDir.title': 'Where this Master keeps its data',
  // TODO(i18n-hi)
  'firstRun.dataDir.help':
    'Choose the drive now, while it is still empty. Afterwards, moving it is a backup and a restore.',
  // TODO(i18n-hi)
  'firstRun.dataDir.change': 'Choose another folder and restart',
  // TODO(i18n-hi)
  'firstRun.dataDir.failed': 'Could not change the folder',
  'firstRun.choose.restore': 'Restore from backup',
  // TODO(i18n-hi)
  'firstRun.error.default': 'Setup failed',
  // TODO(i18n-hi)
  'firstRun.ready.addressLabel': 'Master address',
  // TODO(i18n-hi)
  'firstRun.ready.addressesLabel': 'Master addresses',
  // TODO(i18n-hi)
  'firstRun.ready.continue': 'I have written these down — continue to sign in',
  // TODO(i18n-hi)
  'firstRun.ready.masterIdLabel': 'Master ID',
  // TODO(i18n-hi)
  'firstRun.ready.noAddress': 'This PC has no network address yet — port {port}',
  // TODO(i18n-hi)
  'firstRun.ready.pairingPasswordLabel': 'Pairing password',
  // TODO(i18n-hi)
  'firstRun.ready.panelsHelp':
    'Office Panels normally connect automatically. These details are only needed for manual connection, when automatic search is blocked on your network.',
  // TODO(i18n-hi)
  'firstRun.ready.panelsSection': 'Connecting Office Panels',
  // TODO(i18n-hi)
  'firstRun.ready.passwordLabel': 'Password',
  // TODO(i18n-hi)
  'firstRun.ready.signInSection': 'Sign in to this Master Panel',
  // TODO(i18n-hi)
  'firstRun.ready.title': 'Master Panel is ready',
  // TODO(i18n-hi)
  'firstRun.ready.usernameLabel': 'Username',
  // TODO(i18n-hi)
  'firstRun.ready.writeDownWarning':
    'Write these down now. The two passwords are shown only on this screen and cannot be displayed again.',
  // TODO(i18n-hi)
  'firstRun.setup.companyName': 'Company name (optional)',
  // TODO(i18n-hi)
  'firstRun.setup.companyNamePlaceholder': 'e.g. Shree Ceramics',
  // TODO(i18n-hi)
  'firstRun.setup.description':
    'This PC will store all data for the software. Run this once, on the computer that stays connected to your WiFi router.',
  // TODO(i18n-hi)
  'firstRun.setup.generate': 'Generate connection details',
  // TODO(i18n-hi)
  'firstRun.setup.generating': 'Generating…',
  // TODO(i18n-hi)
  'firstRun.setup.title': 'Set up this Master Panel',
  // TODO(i18n-hi)
  'footer.company': 'Company',
  // TODO(i18n-hi)
  'footer.designSystem': 'Design system',
  // TODO(i18n-hi)
  'footer.offlineSignIn': 'signed in offline',
  // TODO(i18n-hi)
  'footer.signedInAs': '{name} · {role}',
  // TODO(i18n-hi)
  'inventory.action.physicalCount': 'Physical count',
  // TODO(i18n-hi)
  'inventory.action.stockIn': 'Stock in',
  // TODO(i18n-hi)
  'inventory.drawer.adjust': 'Adjust to physical count',
  // TODO(i18n-hi)
  'inventory.drawer.ledgerEmpty.description':
    'Stock in, dispatch and adjustments for this colour will appear here.',
  // TODO(i18n-hi)
  'inventory.drawer.ledgerEmpty.title': 'No movements yet',
  // TODO(i18n-hi)
  'inventory.drawer.ledgerTitle': 'Ledger — signed, append-only',
  // TODO(i18n-hi)
  'inventory.drawer.title': '{product} — {variant}',
  'inventory.empty.description':
    'कैटलॉग का हर उप-उत्पाद यहाँ दिखता है, स्टॉक हो या न हो। फ़िल्टर हटाएँ, या उत्पाद को कैटलॉग में जोड़ें।',
  'inventory.empty.title': 'दिखाने को कुछ नहीं',
  // TODO(i18n-hi)
  'inventory.error.adjust': 'Could not save the count',
  // TODO(i18n-hi)
  'inventory.error.inbound': 'Could not record the incoming stock',
  // TODO(i18n-hi)
  'inventory.error.load': 'Could not load inventory',
  // TODO(i18n-hi)
  'inventory.error.reorder': 'Could not save the reorder level',
  // TODO(i18n-hi)
  'inventory.field.note': 'Note',
  // TODO(i18n-hi)
  'inventory.field.notePlaceholder': 'e.g. factory lot A-77, breakage',
  'inventory.field.product': 'उत्पाद',
  'inventory.field.productPlaceholder': 'उत्पाद चुनें…',
  // TODO(i18n-hi)
  'inventory.filter.all': 'All stock',
  // TODO(i18n-hi)
  'inventory.filter.lowOnly': 'Low only',
  // TODO(i18n-hi)
  'inventory.filterNote': 'Stock only leaves the ledger at dispatch — reservations hold it aside',
  // TODO(i18n-hi)
  'inventory.movementType.adjustment': 'Adjusted',
  // TODO(i18n-hi)
  'inventory.movementType.inbound': 'Stock in',
  // TODO(i18n-hi)
  'inventory.movementType.outbound': 'Dispatched',
  // TODO(i18n-hi)
  'inventory.movements.description':
    'Every row is a signed change, never a total — which is what makes the running figure reconstructible.',
  // TODO(i18n-hi)
  'inventory.movements.empty.description': 'Stock in, dispatch and adjustments will appear here.',
  // TODO(i18n-hi)
  'inventory.movements.empty.title': 'No movements yet',
  // TODO(i18n-hi)
  'inventory.movements.table.change': 'Change',
  // TODO(i18n-hi)
  'inventory.movements.table.note': 'Note',
  // TODO(i18n-hi)
  'inventory.movements.table.product': 'Product',
  // TODO(i18n-hi)
  'inventory.movements.table.reference': 'Reference',
  // TODO(i18n-hi)
  'inventory.movements.table.type': 'Type',
  // TODO(i18n-hi)
  'inventory.movements.table.when': 'When',
  // TODO(i18n-hi)
  'inventory.movements.title': 'Recent movements',
  // TODO(i18n-hi)
  'inventory.physicalCount.description':
    'Enter the number of boxes actually on the shelf — not the difference.',
  // TODO(i18n-hi)
  'inventory.physicalCount.submit': 'Save count',
  // TODO(i18n-hi)
  'inventory.physicalCount.title': 'Physical count',
  // TODO(i18n-hi)
  'inventory.physicalCount.titleForLine': 'भौतिक गिनती — {product} ({variant})',
  // TODO(i18n-hi)
  'inventory.reorderLevelLabel': '{product} {variant} का रीऑर्डर स्तर',
  'inventory.search.placeholder': 'उत्पाद, ब्रांड, कोड या रंग खोजें',
  // TODO(i18n-hi)
  'inventory.section.stockLevels': 'Stock levels',
  // TODO(i18n-hi)
  'inventory.status.healthy': 'Healthy',
  // TODO(i18n-hi)
  'inventory.status.low': 'Low',
  // TODO(i18n-hi)
  'inventory.stockIn.description': 'फ़ैक्टरी या खरीद से आए पीस।',
  // TODO(i18n-hi)
  'inventory.stockIn.submit': 'Add stock',
  // TODO(i18n-hi)
  'inventory.stockIn.title': 'Stock in',
  // TODO(i18n-hi)
  'inventory.stockIn.titleForLine': 'स्टॉक इन — {product} ({variant})',
  // TODO(i18n-hi)
  'inventory.table.code': 'कोड',
  // TODO(i18n-hi)
  'inventory.table.free': 'Free to sell',
  // TODO(i18n-hi)
  'inventory.table.onHand': 'On hand',
  // TODO(i18n-hi)
  'inventory.table.product': 'Product',
  // TODO(i18n-hi)
  'inventory.table.reorder': 'Reorder at',
  // TODO(i18n-hi)
  'inventory.table.reserved': 'Reserved',
  // TODO(i18n-hi)
  'inventory.table.status': 'Status',
  // TODO(i18n-hi)
  'lead.add.details.followUp': 'Follow up on',
  // TODO(i18n-hi)
  'lead.add.details.notes': 'Notes',
  // TODO(i18n-hi)
  'lead.add.errors.generic': 'Could not save the lead',
  // TODO(i18n-hi)
  'lead.add.errors.noProducts': 'Add at least one product',
  // TODO(i18n-hi)
  'lead.add.errors.partyRequired': 'Choose a party for this lead',
  // TODO(i18n-hi)
  'lead.add.party.change': 'Change',
  // TODO(i18n-hi)
  'lead.add.party.search': 'Search party by name, code or phone',
  // TODO(i18n-hi)
  'lead.add.party.title': '1. Party',
  // TODO(i18n-hi)
  // TODO(i18n-hi)
  'lead.add.products.remove': 'Remove',
  // TODO(i18n-hi)
  'lead.add.products.searchLabel': 'उत्पाद खोजें — पहले उत्पाद, फिर उसका उप-उत्पाद',
  // TODO(i18n-hi)
  'lead.add.products.title': '2. Products',
  // TODO(i18n-hi)
  'lead.add.products.useSuggested': 'Use “{value}”',
  // TODO(i18n-hi)
  'lead.add.save': 'Save lead',
  // TODO(i18n-hi)
  'lead.add.saving': 'Saving…',
  // TODO(i18n-hi)
  'lead.add.savingHint': 'Saves on this machine first — offline is the normal path',
  // TODO(i18n-hi)
  'lead.add.title': 'New lead',
  'lead.edit.action': 'लीड संपादित करें',
  'lead.edit.saved': 'लीड {id} अपडेट हुई',
  'lead.edit.title': 'लीड संपादित करें',
  // TODO(i18n-hi)
  'lead.badge.converted': 'converted',
  // TODO(i18n-hi)
  'lead.badge.incomplete': 'incomplete',
  // TODO(i18n-hi)
  'lead.badge.notSynced': 'not synced',
  // TODO(i18n-hi)
  'lead.board.cardMenu': 'Lead actions',
  // TODO(i18n-hi)
  'lead.board.convertedNote': 'Converted leads leave the board',
  // TODO(i18n-hi)
  'lead.board.convertedToast': 'बदल गया — {qty} पीस {orderId} के लिए आरक्षित',
  // TODO(i18n-hi)
  'lead.board.emptyColumn': 'No leads at this stage.',
  // TODO(i18n-hi)
  'lead.board.emptyDesc': 'Leads you create appear here, online or off.',
  // TODO(i18n-hi)
  'lead.board.emptyTitle': 'No leads yet',
  // TODO(i18n-hi)
  'lead.board.filter.all': 'All stages',
  // TODO(i18n-hi)
  'lead.board.menu.convert': 'Convert to order',
  // TODO(i18n-hi)
  'lead.board.menu.convertBlocked': 'Choose packaging before converting',
  // TODO(i18n-hi)
  'lead.board.menu.moveTo': 'Move to {stage}',
  // TODO(i18n-hi)
  'lead.board.menu.open': 'Open',
  // TODO(i18n-hi)
  'lead.board.noPipelineDesc':
    'The lead pipeline configuration has not arrived from the Master Panel yet.',
  // TODO(i18n-hi)
  'lead.board.noPipelineTitle': 'Waiting for the pipeline',
  // TODO(i18n-hi)
  'lead.board.tab.board': 'Board',
  // TODO(i18n-hi)
  'lead.board.tab.list': 'List',
  'lead.board.via': '{source} से',
  // TODO(i18n-hi)
  'lead.detail.addNote': 'Add',
  // TODO(i18n-hi)
  'lead.detail.addNotePlaceholder': 'Add a note…',
  // TODO(i18n-hi)
  'lead.detail.city': 'City',
  // TODO(i18n-hi)
  'lead.detail.code': 'Code',
  // TODO(i18n-hi)
  'lead.detail.convertAction': 'Convert to order',
  // TODO(i18n-hi)
  'lead.detail.convertDesc':
    'इन लाइनों को ज्यों का त्यों कॉपी करके ऑर्डर बनाता है, और हर वेरिएंट का स्टॉक आरक्षित करता है।',
  // TODO(i18n-hi)
  'lead.detail.convertMissingPackaging':
    'Choose packaging for {names} first — it is never filled in automatically.',
  // TODO(i18n-hi)
  'lead.detail.convertTitle': 'Convert to order',
  // TODO(i18n-hi)
  'lead.detail.convertedMessage': 'This lead became order {orderId}.',
  // TODO(i18n-hi)
  'lead.detail.created': 'Created',
  // TODO(i18n-hi)
  'lead.detail.details': 'Details',
  // TODO(i18n-hi)
  'lead.detail.dispatchLabel': 'Dispatch address label',
  // TODO(i18n-hi)
  'lead.detail.expectedDate': 'Expected dispatch date',
  // TODO(i18n-hi)
  'lead.detail.followUp': 'Follow up',
  // TODO(i18n-hi)
  'lead.detail.history': 'History',
  // TODO(i18n-hi)
  'lead.detail.incompleteWarning':
    'Missing required information: {fields}. The lead is saved — fill this in when you can.',
  // TODO(i18n-hi)
  'lead.detail.lineItems': 'Line items',
  // TODO(i18n-hi)
  'lead.detail.name': 'Name',
  // TODO(i18n-hi)
  'lead.detail.no': 'No',
  // TODO(i18n-hi)
  'lead.detail.noHistory': 'Nothing recorded yet.',
  // TODO(i18n-hi)
  'lead.detail.noPermission': 'Your role does not include lead.convert.',
  // TODO(i18n-hi)
  'lead.detail.packagingNotChosen': 'not chosen',
  // TODO(i18n-hi)
  'lead.detail.party': 'Party',
  // TODO(i18n-hi)
  'lead.detail.partyRates': 'पार्टी-वार रिकॉर्ड',
  // TODO(i18n-hi)
  'lead.detail.phone': 'Phone',
  // TODO(i18n-hi)
  'lead.detail.source': 'Source',
  // TODO(i18n-hi)
  'lead.detail.stageLabel': 'Move this lead to',
  // TODO(i18n-hi)
  'lead.detail.yes': 'Yes',
  'lead.error.addNote': 'नोट नहीं जोड़ा जा सका',
  'lead.error.convert': 'लीड को ऑर्डर में नहीं बदला जा सका',
  'lead.error.move': 'लीड का चरण नहीं बदला जा सका',
  // TODO(i18n-hi)
  'lead.list.col.followUp': 'Follow up',
  // TODO(i18n-hi)
  'lead.list.col.lead': 'Lead',
  // TODO(i18n-hi)
  'lead.list.col.party': 'Party',
  'lead.list.col.products': 'उत्पाद',
  // TODO(i18n-hi)
  'lead.list.col.source': 'Source',
  // TODO(i18n-hi)
  'lead.list.col.stage': 'Stage',
  // TODO(i18n-hi)
  'lead.list.col.sync': 'Sync',
  // TODO(i18n-hi)
  'lead.list.pending': 'pending',
  // TODO(i18n-hi)
  'lead.list.synced': 'synced',
  'lead.previewPdf': 'PDF पूर्वावलोकन',
  // TODO(i18n-hi)
  'leadsOrders.error.convert': 'Could not convert the lead',
  // TODO(i18n-hi)
  'leadsOrders.error.dispatch': 'Could not dispatch the order',
  // TODO(i18n-hi)
  'leadsOrders.error.load': 'Could not load',
  // TODO(i18n-hi)
  'leadsOrders.error.moveLead': 'Could not move the lead',
  // TODO(i18n-hi)
  'leadsOrders.error.moveOrder': 'Could not move the order',
  // TODO(i18n-hi)
  'leadsOrders.leads.column.created': 'Created',
  // TODO(i18n-hi)
  'leadsOrders.leads.column.lead': 'Lead',
  // TODO(i18n-hi)
  'leadsOrders.leads.column.party': 'Party',
  // TODO(i18n-hi)
  'leadsOrders.leads.column.products': 'Products',
  // TODO(i18n-hi)
  'leadsOrders.leads.column.stage': 'Stage',
  // TODO(i18n-hi)
  'leadsOrders.leads.convert': 'Convert to order',
  // TODO(i18n-hi)
  'leadsOrders.leads.convertBlocked': 'Every line needs packaging before this can become an order',
  // TODO(i18n-hi)
  'leadsOrders.leads.converted': 'converted',
  // TODO(i18n-hi)
  'leadsOrders.leads.convertedOrder': 'order {id}',
  // TODO(i18n-hi)
  'leadsOrders.leads.empty.converted.title': 'No converted leads yet',
  // TODO(i18n-hi)
  'leadsOrders.leads.empty.open.description': 'Office Panels raise them.',
  // TODO(i18n-hi)
  'leadsOrders.leads.empty.open.title': 'No open leads',
  // TODO(i18n-hi)
  'leadsOrders.leads.incomplete': 'incomplete',
  // TODO(i18n-hi)
  'leadsOrders.orders.column.fromLead': 'From lead',
  // TODO(i18n-hi)
  'leadsOrders.orders.column.order': 'Order',
  // TODO(i18n-hi)
  'leadsOrders.orders.column.party': 'Party',
  // TODO(i18n-hi)
  'leadsOrders.orders.column.products': 'Products',
  // TODO(i18n-hi)
  'leadsOrders.orders.column.stage': 'Stage',
  // TODO(i18n-hi)
  'leadsOrders.orders.column.weight': 'Weight',
  // TODO(i18n-hi)
  'leadsOrders.orders.dispatch': 'Dispatch',
  // TODO(i18n-hi)
  'leadsOrders.orders.dispatched': 'Dispatched {when}',
  // TODO(i18n-hi)
  'leadsOrders.orders.empty.description': 'They appear here once a lead is converted.',
  // TODO(i18n-hi)
  'leadsOrders.orders.empty.title': 'No orders yet',
  // TODO(i18n-hi)
  'leadsOrders.orders.weightManual': 'Entered by hand, not summed from the lines',
  // TODO(i18n-hi)
  'leadsOrders.tab.converted': 'Converted leads',
  // TODO(i18n-hi)
  'leadsOrders.tab.leads': 'Open leads',
  // TODO(i18n-hi)
  'leadsOrders.tab.orders': 'Orders',
  // TODO(i18n-hi)
  'leadsOrders.title': 'Leads & orders',
  // TODO(i18n-hi)
  'leadsOrders.unit.kg': 'kg',
  // TODO(i18n-hi)
  'logs.action.export': 'Export CSV',
  // TODO(i18n-hi)
  'logs.action.verify': 'Verify chain',
  'integrations.loadFailed': 'Could not load the integrations',
  'integrations.tab.keys': 'API keys',
  'integrations.tab.connectors': 'Connections',
  'integrations.keys.title': 'API keys',
  'integrations.keys.help':
    'A key lets another program on this network read and correct this company’s data. It can never do more than the person it belongs to.',
  'integrations.keys.issue': 'Issue a key',
  'integrations.keys.label': 'Label',
  'integrations.keys.prefix': 'Key',
  'integrations.keys.owner': 'Belongs to',
  'integrations.keys.ownerChoose': 'Choose a person',
  'integrations.keys.scopes': 'Permissions',
  'integrations.keys.scopesHelp': 'What this key may do, narrowed from what its owner may do',
  'integrations.keys.state': 'State',
  'integrations.keys.revoke': 'Revoke',
  'integrations.keys.revoked': 'Revoked',
  'integrations.keys.unused': 'Never used',
  'integrations.keys.lastUsed': 'Last used {when}',
  'integrations.keys.empty': 'No keys have been issued',
  'integrations.keys.issuedTitle': 'The key for {name}',
  'integrations.keys.issuedHelp':
    'Copy this now. It is shown once and cannot be shown again — a lost key is replaced, never recovered.',
  'integrations.connectors.title': 'Connections',
  'integrations.connectors.help':
    'A connection reads another system on this network and brings its records in. Nothing is written until a dry run has shown what would change.',
  'integrations.connectors.new': 'Add a connection',
  'integrations.connectors.edit': 'Edit the connection',
  'integrations.connectors.label': 'Name',
  'integrations.connectors.slug': 'Short code',
  'integrations.connectors.baseUrl': 'Address',
  'integrations.connectors.auth': 'Authentication',
  'integrations.connectors.authKind': 'How it signs in',
  'integrations.connectors.auth.none': 'No sign-in',
  'integrations.connectors.auth.header': 'A header',
  'integrations.connectors.auth.bearer': 'A bearer token',
  'integrations.connectors.auth.basic': 'A username and password',
  'integrations.connectors.authHeader': 'Header name',
  'integrations.connectors.authUsername': 'Username',
  'integrations.connectors.credential': 'Credential',
  'integrations.connectors.credentialStored': 'One is stored. Leave this empty to keep it.',
  'integrations.connectors.running': 'Running',
  'integrations.connectors.runAs': 'Writes as',
  'integrations.connectors.schedule': 'Schedule',
  'integrations.connectors.schedule.manual': 'Only when asked',
  'integrations.connectors.schedule.periodic': 'On a timer',
  'integrations.connectors.intervalMin': 'Minutes between runs',
  'integrations.connectors.everyMinutes': 'Every {minutes} minutes',
  'integrations.connectors.enabled': 'Enabled',
  'integrations.connectors.lastRun': 'Last run',
  'integrations.connectors.never': 'Never run',
  'integrations.connectors.mapping': 'Fields',
  'integrations.connectors.dryRun': 'Dry run',
  'integrations.connectors.import': 'Import',
  'integrations.connectors.empty': 'No connections yet',
  'integrations.connectors.runs': 'Recent runs',
  'integrations.connectors.runStarted': 'Started',
  'integrations.connectors.runMode': 'Kind',
  'integrations.connectors.runStatus': 'Result',
  'integrations.connectors.runCounts': 'Records',
  'integrations.connectors.ranSummary': '{created} added, {updated} changed, {failed} failed',
  'integrations.mapping.title': 'Fields for {name}',
  'integrations.mapping.help':
    'Say where each field lives in the other system. Test the connection first and the boxes will offer what it actually returned.',
  'integrations.mapping.products': 'Products',
  'integrations.mapping.parties': 'Parties',
  'integrations.mapping.test': 'Test',
  'integrations.mapping.saved': 'Mapping saved. Run a dry run before importing.',
  'integrations.mapping.probeOk': 'The connection works — {count} records came back',
  'integrations.mapping.probeFailed': 'The other system did not answer',
  'integrations.mapping.request': 'Where to read from',
  'integrations.mapping.path': 'Path',
  'integrations.mapping.itemsPointer': 'Where the list is',
  'integrations.mapping.remoteIdPointer': 'Where their id is',
  'integrations.mapping.fields': 'Fields',
  'integrations.mapping.localField': 'Our field',
  'integrations.mapping.remotePointer': 'Theirs',
  'integrations.mapping.transform': 'Convert',
  'integrations.mapping.transformNone': 'As it comes',
  'integrations.mapping.transform.trim': 'Trim spaces',
  'integrations.mapping.transform.upper': 'Upper case',
  'integrations.mapping.transform.lower': 'Lower case',
  'integrations.mapping.transform.digits': 'Digits only',
  'integrations.mapping.onConflict': 'If they differ',
  'integrations.mapping.remoteWins': 'Take theirs',
  'integrations.mapping.localWins': 'Keep ours',
  'integrations.mapping.flag': 'Ask a person',
  'integrations.mapping.required': 'Required',
  'nav.master.integrations': 'Integrations',
  // Oblique, not `कोई`: every `activity.*` template puts a postposition after
  // `{actor}` (`{actor} ने …`). An English stub there would read "किसी issued…",
  // so `i18n-coverage.test.ts` fails on one until it is translated.
  'logs.actor.unknown': 'किसी',
  'logs.actorType.api_key': 'An API key',
  'logs.actorType.connector': 'A connection',
  'logs.actorType.office_panel': 'An office panel',
  // TODO(i18n-hi)
  'logs.actorType.system': 'The system',
  // TODO(i18n-hi)
  'logs.actorType.user': 'A person',
  // TODO(i18n-hi)
  'logs.chain.preChain': 'pre-chain',
  // TODO(i18n-hi)
  'logs.chain.preChainHint': 'Recorded before hash chaining — unverifiable, not broken',
  // TODO(i18n-hi)
  'logs.drawer.details': 'Recorded details',
  // TODO(i18n-hi)
  'logs.drawer.entryId': 'Entry',
  // TODO(i18n-hi)
  'logs.drawer.hash': 'Hash',
  // TODO(i18n-hi)
  'logs.drawer.noDetails': 'This entry carries no extra detail.',
  // TODO(i18n-hi)
  'logs.drawer.record': 'Record',
  // TODO(i18n-hi)
  'logs.drawer.sequence': 'Sequence',
  // TODO(i18n-hi)
  'logs.drawer.token': 'Token',
  // TODO(i18n-hi)
  'logs.drawer.when': 'When',
  // TODO(i18n-hi)
  'logs.drawer.who': 'Who',
  // TODO(i18n-hi)
  'logs.empty.description': 'Every change made in this panel or an office panel appears here.',
  // TODO(i18n-hi)
  'logs.empty.title': 'Nothing recorded yet',
  // TODO(i18n-hi)
  'logs.emptyFiltered.description': 'Widen the date range, or clear the filters.',
  // TODO(i18n-hi)
  'logs.emptyFiltered.title': 'No entries match those filters',
  // TODO(i18n-hi)
  'logs.error.retry': 'Try again',
  // TODO(i18n-hi)
  'logs.error.title': 'Could not load the activity log',
  // TODO(i18n-hi)
  'logs.filter.actionAll': 'All actions',
  // TODO(i18n-hi)
  'logs.filter.actionLabel': 'Filter by action',
  // TODO(i18n-hi)
  'logs.filter.actorAll': 'Anyone',
  // TODO(i18n-hi)
  'logs.filter.actorLabel': 'Filter by who',
  // TODO(i18n-hi)
  'logs.filter.clear': 'Clear filters',
  // TODO(i18n-hi)
  'logs.filter.entityAll': 'All record types',
  // TODO(i18n-hi)
  'logs.filter.entityLabel': 'Filter by record type',
  // TODO(i18n-hi)
  'logs.filter.facetsUnavailable': 'Could not load the filter choices',
  // TODO(i18n-hi)
  'logs.filter.fromLabel': 'From date',
  // TODO(i18n-hi)
  'logs.filter.searchPlaceholder': 'Search records and details',
  // TODO(i18n-hi)
  'logs.filter.toLabel': 'To date',
  // TODO(i18n-hi)
  'logs.noPermission.description': 'Your role does not include {permission}.',
  // TODO(i18n-hi)
  'logs.noPermission.title': 'You cannot see the activity log',
  // TODO(i18n-hi)
  'logs.section.description':
    'Append-only and hash-chained: every entry seals the one before it, so a row cannot be altered or removed without the chain saying so.',
  // TODO(i18n-hi)
  'logs.section.title': 'Activity log',
  // TODO(i18n-hi)
  'logs.table.record': 'Record',
  // TODO(i18n-hi)
  'logs.table.sequence': 'Seq.',
  // TODO(i18n-hi)
  'logs.table.what': 'What happened',
  // TODO(i18n-hi)
  'logs.table.when': 'When',
  // TODO(i18n-hi)
  'logs.table.who': 'Who',
  // TODO(i18n-hi)
  'logs.verify.break.hash_mismatch': "The entry's own hash does not match its contents.",
  // TODO(i18n-hi)
  'logs.verify.break.prev_hash_mismatch':
    'The entry does not seal the one before it — an entry was replaced or inserted.',
  // TODO(i18n-hi)
  'logs.verify.break.sequence_gap': 'An entry is missing from the sequence.',
  // TODO(i18n-hi)
  'logs.verify.breakAt': 'First break',
  // TODO(i18n-hi)
  'logs.verify.breakDetail': 'entry {id}, recorded {when}',
  // TODO(i18n-hi)
  'logs.verify.broken': 'Tampering detected. The chain first breaks at sequence {sequence}.',
  // TODO(i18n-hi)
  'logs.verify.checked': 'Entries checked',
  // TODO(i18n-hi)
  'logs.verify.close': 'Close',
  // TODO(i18n-hi)
  'logs.verify.failed': 'Could not verify the chain',
  // TODO(i18n-hi)
  'logs.verify.ok': 'Intact — every hash in the range recomputes to what is stored.',
  // TODO(i18n-hi)
  'logs.verify.range': 'Range checked',
  // TODO(i18n-hi)
  'logs.verify.rangeEmpty': 'Nothing to check — the log is empty.',
  // TODO(i18n-hi)
  'logs.verify.rangeValue': 'sequence {from} to {to}',
  // TODO(i18n-hi)
  'logs.verify.running': 'Recomputing every hash in the range…',
  // TODO(i18n-hi)
  'logs.verify.skipped': 'Skipped as pre-chain',
  // TODO(i18n-hi)
  'logs.verify.title': 'Audit chain verification',
  // TODO(i18n-hi)
  'logs.verify.truncated':
    'Only the most recent stretch was checked — the range was capped to keep the scan bounded.',
  // TODO(i18n-hi)
  'master.app.panel': 'Master Panel',
  // TODO(i18n-hi)
  'master.backup.export.title': 'Export whole data',
  // TODO(i18n-hi)
  'master.backup.restore.confirmWipe':
    'This installation already has data. Restoring will replace it completely. Type CONFIRM to proceed.',
  // TODO(i18n-hi)
  'master.settings.storage.title': 'Storage on this PC',
  // TODO(i18n-hi)
  'master.sync.conflictReview': '{count} conflicts — review',
  // TODO(i18n-hi)
  'master.sync.offline': '{count} offline',
  // TODO(i18n-hi)
  'master.sync.offlinePending': '{count} offline — {pending} pending',
  // TODO(i18n-hi)
  'master.sync.pendingChanges': 'Changes waiting on panels',
  // TODO(i18n-hi)
  'master.sync.popoverTitle.offline': 'Panels unreachable',
  // TODO(i18n-hi)
  'master.sync.popoverTitle.offlinePending': 'Panels unreachable — changes pending',
  // TODO(i18n-hi)
  'master.sync.popoverTitle.synced': 'Everything synced',
  // TODO(i18n-hi)
  'keys.command.palette': 'कमांड पैलेट',
  'keys.command.search': 'खोज',
  'keys.command.save': 'सहेजें',
  'keys.command.new': 'नया रिकॉर्ड',
  'keys.command.reset': 'यह स्क्रीन रीसेट करें',
  'keys.command.refresh': 'ताज़ा करें',
  'keys.command.help': 'कीबोर्ड शॉर्टकट',
  'keys.palette.placeholder': 'कोई कमांड लिखें, या रिकॉर्ड खोजें',
  'keys.palette.commands': 'कमांड',
  'keys.palette.records': 'रिकॉर्ड',
  'keys.palette.empty': 'कुछ भी मेल नहीं खाता',
  'keys.palette.offline': 'यह पैनल जो सहेजे है उसी में खोज — मास्टर उपलब्ध नहीं',
  'keys.settings.hint':
    'Shortcuts are stored on this machine, so a change here does not follow you to another PC.',
  'keys.settings.resetAll': 'Restore defaults',
  'keys.settings.change': 'Change shortcut',
  'keys.settings.press': 'Press a key…',
  'keys.settings.clear': 'Clear shortcut',
  'keys.settings.reserved':
    'Escape and Tab are reserved for closing dialogs and moving between fields.',
  'keys.settings.title': 'Keyboard shortcuts',
  'keys.help.title': 'कीबोर्ड शॉर्टकट',
  'keys.help.unbound': 'बाध्य नहीं',
  'keys.help.conflict': 'किसी अन्य कमांड के साथ साझा',
  'nav.catalogue': 'Catalogue',
  'nav.collapse': 'समेटें',
  'nav.collapseSidebar': 'साइडबार समेटें',
  // TODO(i18n-hi)
  'nav.conflicts': 'Conflicts',
  // TODO(i18n-hi)
  'nav.dashboard': 'Dashboard',
  'nav.expandSidebar': 'साइडबार फैलाएँ',
  // TODO(i18n-hi)
  'nav.leads': 'Leads',
  // TODO(i18n-hi)
  'nav.master.access': 'Roles & users',
  // TODO(i18n-hi)
  'nav.master.admin': 'Admin',
  // TODO(i18n-hi)
  'nav.master.conflicts': 'Conflicts',
  // TODO(i18n-hi)
  'nav.master.dashboard': 'Dashboard',
  // TODO(i18n-hi)
  'nav.master.editRole': 'Edit role · {name}',
  // TODO(i18n-hi)
  'nav.master.editUser': 'Edit person · {name}',
  // TODO(i18n-hi)
  'nav.master.fields': 'Fields',
  // TODO(i18n-hi)
  'nav.master.inventory': 'Inventory',
  // TODO(i18n-hi)
  'nav.master.leadsOrders': 'Leads & orders',
  // TODO(i18n-hi)
  'nav.master.logs': 'Activity log',
  // TODO(i18n-hi)
  'nav.master.panels': 'Office panels',
  // TODO(i18n-hi)
  'nav.master.partyAccess': 'Party access',
  // TODO(i18n-hi)
  'nav.master.recycleBin': 'Recycle bin',
  // TODO(i18n-hi)
  'nav.master.reports': 'Reports',
  // TODO(i18n-hi)
  'nav.master.settings': 'Settings',
  // TODO(i18n-hi)
  'nav.master.work': 'Work',
  'nav.modules': 'मॉड्यूल',
  // TODO(i18n-hi)
  'nav.orders': 'Orders',
  // TODO(i18n-hi)
  'nav.parties': 'Parties',
  // TODO(i18n-hi)
  'nav.partyAccess': 'Party access',
  // TODO(i18n-hi)
  'nav.products': 'Products',
  // TODO(i18n-hi)
  'nav.settings': 'Settings',
  // TODO(i18n-hi)
  'nav.system': 'System',
  'nav.unfold': 'उप-पृष्ठ दिखाएँ',
  // TODO(i18n-hi)
  'nav.updates': 'App update',
  // TODO(i18n-hi)
  'nav.work': 'Work',
  // TODO(i18n-hi)
  'office.app.panel': 'Office Panel',
  // TODO(i18n-hi)
  'office.backup.export.title': 'Export this device',
  // TODO(i18n-hi)
  'office.backup.restore.confirmWipe':
    'This device already has data. Restoring will replace it completely. Type CONFIRM to proceed.',
  // TODO(i18n-hi)
  'office.settings.storage.title': 'Storage on this device',
  // TODO(i18n-hi)
  'office.sync.conflictReview': '{count} fields resolved — review',
  // TODO(i18n-hi)
  'office.sync.offline': 'Offline',
  // TODO(i18n-hi)
  'office.sync.offlinePending': 'Offline — {count} pending',
  // TODO(i18n-hi)
  'office.sync.pendingChanges': 'Pending changes',
  // TODO(i18n-hi)
  'office.sync.popoverTitle.offline': 'Offline',
  // TODO(i18n-hi)
  'office.sync.popoverTitle.offlinePending': 'Offline — pending changes',
  // TODO(i18n-hi)
  'office.sync.popoverTitle.synced': 'Synced',
  // TODO(i18n-hi)
  'orders.badge.dispatched': 'dispatched',
  // TODO(i18n-hi)
  'orders.column.fromLead': 'From lead',
  // TODO(i18n-hi)
  'orders.column.order': 'Order',
  // TODO(i18n-hi)
  'orders.column.packaging': 'Packaging',
  'orders.column.grade': 'ग्रेड',
  'orders.column.colour': 'रंग',
  // TODO(i18n-hi)
  'orders.column.party': 'Party',
  // TODO(i18n-hi)
  'orders.column.product': 'Product',
  // TODO(i18n-hi)
  'orders.column.stage': 'Stage',
  // TODO(i18n-hi)
  'orders.column.status': 'Status',
  // TODO(i18n-hi)
  'orders.column.sync': 'Sync',
  // TODO(i18n-hi)
  'orders.column.weight': 'Weight',
  // TODO(i18n-hi)
  'orders.detail.dispatch': 'Dispatch',
  // TODO(i18n-hi)
  'orders.detail.dispatchButton': 'Mark dispatched',
  // TODO(i18n-hi)
  'orders.detail.dispatchNote':
    'Takes {count} reservation(s) off the stock ledger. This cannot be undone from here.',
  // TODO(i18n-hi)
  'orders.detail.dispatchNoteLabel': 'Note',
  // TODO(i18n-hi)
  'orders.detail.dispatchNotePlaceholder': 'e.g. lorry AB-12',
  // TODO(i18n-hi)
  'orders.detail.dispatchedBanner':
    'Dispatched {when} — reservations consumed, ledger entries written.',
  // TODO(i18n-hi)
  'orders.detail.history': 'History',
  // TODO(i18n-hi)
  'orders.detail.noDispatchPermission': 'Your role does not include {permission}.',
  // TODO(i18n-hi)
  'orders.detail.noReservations': 'No reservations.',
  // TODO(i18n-hi)
  'orders.detail.products': 'Products',
  // TODO(i18n-hi)
  'orders.detail.reservations': 'Stock held for this order',
  // TODO(i18n-hi)
  'orders.detail.stage': 'Stage',
  // TODO(i18n-hi)
  'orders.detail.stageLabel': 'Move this order to',
  // TODO(i18n-hi)
  'orders.detail.subtitleNoLead': '{id}',
  // TODO(i18n-hi)
  'orders.detail.subtitleWithLead': '{id} · from {leadId}',
  // TODO(i18n-hi)
  'orders.detail.weight': 'Weight',
  // TODO(i18n-hi)
  'orders.detail.weightComputed': 'Computed from the lines: {value} kg',
  'orders.detail.weightOverrideInvalid': 'वज़न संख्या में लिखें, या इसे खाली छोड़ दें',
  // TODO(i18n-hi)
  'orders.detail.weightOverrideLabel': 'Override (leave blank to use the computed figure)',
  // TODO(i18n-hi)
  'orders.detail.weightOverridePlaceholder': 'Override',
  // TODO(i18n-hi)
  'orders.detail.weightShowing': 'Showing the {source} figure.',
  // TODO(i18n-hi)
  'orders.empty.description': 'Orders converted from leads appear here.',
  // TODO(i18n-hi)
  'orders.empty.filteredTitle': 'No orders at this stage.',
  // TODO(i18n-hi)
  'orders.empty.title': 'No orders yet',
  'orders.error.dispatch': 'ऑर्डर नहीं भेजा जा सका',
  'orders.error.move': 'ऑर्डर का चरण नहीं बदला जा सका',
  'orders.error.saveWeight': 'वज़न सहेजा नहीं जा सका',
  // TODO(i18n-hi)
  'orders.filter.allStages': 'All stages',
  // TODO(i18n-hi)
  'orders.filter.note': 'Dispatch consumes reservations — it cannot be undone here',
  // TODO(i18n-hi)
  'orders.reservation.status.active': 'Active',
  // TODO(i18n-hi)
  'orders.reservation.status.consumed': 'Consumed',
  // TODO(i18n-hi)
  'orders.reservation.status.released': 'Released',
  // TODO(i18n-hi)
  'orders.sync.pending': 'Not synced',
  // TODO(i18n-hi)
  'orders.sync.synced': 'Synced',
  // TODO(i18n-hi)
  'orders.unit.kg': 'kg',
  // TODO(i18n-hi)
  'orders.waitingPipeline': 'Waiting for the pipeline configuration from the Master Panel…',
  // TODO(i18n-hi)
  'panels.action.open': 'Open',
  // TODO(i18n-hi)
  'panels.action.remove': 'Remove',
  // TODO(i18n-hi)
  'panels.action.rename': 'Rename',
  // TODO(i18n-hi)
  'panels.add.action': 'Add Office Panel',
  // TODO(i18n-hi)
  'panels.add.cancel': 'Cancel',
  // TODO(i18n-hi)
  'panels.add.description':
    'Press this, then start automatic connection on the office PC. This Master only accepts new panels while you are waiting here.',
  // TODO(i18n-hi)
  'panels.add.startFailed': 'Could not start pairing',
  // TODO(i18n-hi)
  'panels.add.title': 'Add Office Panel',
  // TODO(i18n-hi)
  'panels.add.waitingBody':
    'On the office PC, open the Office Panel and press "Proceed with Auto Connection". It will find this Master automatically.',
  // TODO(i18n-hi)
  'panels.add.waitingTitle': 'Waiting for office panel…',
  // TODO(i18n-hi)
  'panels.detail.connection': 'Live connection',
  // TODO(i18n-hi)
  'panels.detail.connectionDown': 'Not connected',
  // TODO(i18n-hi)
  'panels.detail.connectionLive': 'Connected now',
  // TODO(i18n-hi)
  'panels.detail.created': 'First seen',
  // TODO(i18n-hi)
  'panels.detail.history': 'History',
  // TODO(i18n-hi)
  'panels.detail.id': 'Panel ID',
  // TODO(i18n-hi)
  'panels.detail.identity': 'Identity',
  // TODO(i18n-hi)
  // TODO(i18n-hi)
  'panels.detail.network': 'Network',
  // TODO(i18n-hi)
  'panels.detail.revokedNote':
    'This panel was removed. It has to pair again before it can connect.',
  // TODO(i18n-hi)
  'panels.detail.role': 'Acts under role',
  // TODO(i18n-hi)
  'panels.detail.roleDefault': 'Office (default)',
  // TODO(i18n-hi)
  'panels.detail.status.active': 'Paired',
  // TODO(i18n-hi)
  'panels.detail.status.pending': 'Waiting to pair',
  // TODO(i18n-hi)
  'panels.detail.status.revoked': 'Removed',
  // TODO(i18n-hi)
  'panels.detail.statusLabel': 'Pairing',
  // TODO(i18n-hi)
  'panels.detail.updated': 'Last changed',
  // TODO(i18n-hi)
  'panels.empty.description': 'Panels you pair appear here, online or off.',
  // TODO(i18n-hi)
  'panels.empty.title': 'No office panels yet',
  // TODO(i18n-hi)
  'panels.list.title': 'Connected Office Panels',
  // TODO(i18n-hi)
  'panels.rename.cancel': 'Cancel',
  // TODO(i18n-hi)
  'panels.rename.failed': 'Could not rename the panel',
  // TODO(i18n-hi)
  'panels.rename.label': 'Name for this office panel',
  // TODO(i18n-hi)
  'panels.rename.save': 'Save',
  // TODO(i18n-hi)
  'panels.rename.title': 'Rename "{name}"',
  // TODO(i18n-hi)
  'panels.revoke.body': 'That PC will have to connect again.',
  // TODO(i18n-hi)
  'panels.revoke.cancel': 'Cancel',
  // TODO(i18n-hi)
  'panels.revoke.failed': 'Could not remove the panel',
  // TODO(i18n-hi)
  'panels.revoke.title': 'Remove "{name}"?',
  // TODO(i18n-hi)
  'panels.status.connected': 'Connected',
  // TODO(i18n-hi)
  'panels.status.offline': 'Offline',
  // TODO(i18n-hi)
  'panels.status.removed': 'Removed',
  // TODO(i18n-hi)
  'panels.table.address': 'Address',
  // TODO(i18n-hi)
  'panels.table.deviceCode': 'Device code',
  // TODO(i18n-hi)
  'panels.table.lastSeen': 'Last seen',
  // TODO(i18n-hi)
  'panels.table.name': 'Name',
  // TODO(i18n-hi)
  'panels.table.paired': 'Paired',
  // TODO(i18n-hi)
  'panels.table.status': 'Status',
  // TODO(i18n-hi)
  'party.createFailed': 'Could not create the party',
  // TODO(i18n-hi)
  'party.detail.access.manage':
    'This party is assigned to you. You can see and change its records.',
  // TODO(i18n-hi)
  'party.detail.access.open':
    'Nobody is assigned, so everyone with the right role can see and work this party.',
  // TODO(i18n-hi)
  'party.detail.access.view': 'You can see this party and its records, but not change them.',
  // TODO(i18n-hi)
  'party.detail.accessTitle': 'Who can reach this party',
  // TODO(i18n-hi)
  'party.detail.city': 'City',
  // TODO(i18n-hi)
  'party.detail.contact': 'Contact',
  // TODO(i18n-hi)
  'party.detail.editAction': 'Edit party',
  // TODO(i18n-hi)
  'party.detail.email': 'Email',
  // TODO(i18n-hi)
  'party.detail.leads.none': 'No leads yet for this party.',
  // TODO(i18n-hi)
  'party.detail.leadsTitle': 'Recent leads',
  // TODO(i18n-hi)
  'party.detail.phone': 'Phone',
  // TODO(i18n-hi)
  'party.detail.records.none': 'कोई पार्टी-वार रिकॉर्ड नहीं — कैटलॉग के नाम लागू होते हैं।',
  'party.detail.records.ownName': 'पार्टी का नाम',
  'party.detail.records.product': 'कैटलॉग मॉडल',
  'party.detail.recordsTitle': 'पार्टी के अपने उत्पाद रिकॉर्ड',
  // TODO(i18n-hi)
  'party.detail.since': 'Since',
  // TODO(i18n-hi)
  'party.detail.taxId': 'Tax ID',
  // TODO(i18n-hi)
  'party.edit.title': 'Edit party',
  // TODO(i18n-hi)
  'party.field.altPhone': 'वैकल्पिक फ़ोन',
  'party.field.email': 'ईमेल',
  'party.field.addressLine1': 'पता',
  'party.field.addressLine2': 'पते की दूसरी पंक्ति',
  'party.field.state': 'राज्य',
  'party.field.pincode': 'पिन कोड',
  'party.group.identity': 'पहचान',
  'party.group.contact': 'संपर्क',
  'party.group.address': 'पता',
  'party.group.tax': 'कर और टिप्पणियाँ',
  // --- Bulk product import: the Office catalogue's import dialog -----------
  'import.title': 'उत्पाद आयात करें',
  'import.chooseFile': 'फ़ाइल चुनें',
  'import.dropHint': 'यहाँ .csv या .xlsx फ़ाइल छोड़ें, या एक चुनें',
  'import.template.csv': 'खाली CSV',
  'import.template.xlsx': 'खाली Excel',
  'import.template.hint':
    'खाली टेम्पलेट डाउनलोड करें, उसे भरें और वापस अपलोड करें। हर वेरिएंट की एक पंक्ति; Guide शीट में हर कॉलम की जानकारी है।',
  'import.mode.label': 'पहले से मौजूद उत्पाद कोड',
  'import.mode.create': 'छोड़ दें',
  'import.mode.upsert': 'अपडेट करें',
  'import.fileTooLarge': 'यह फ़ाइल {maxMb} MB से बड़ी है',
  'import.checking': 'फ़ाइल जाँची जा रही है…',
  'import.preview.summary':
    '{created} जोड़े जाएँगे, {updated} अपडेट होंगे, {skipped} पहले से मौजूद, {failed} में समस्या',
  'import.preview.ignored': 'अनदेखे कॉलम: {columns}',
  'import.preview.sample': 'पहली पंक्तियाँ, जैसी समझी गईं',
  'import.preview.issues': 'समस्याएँ',
  'import.preview.issuesTruncated': 'केवल पहली {count} समस्याएँ सूचीबद्ध हैं',
  'import.preview.nothing': 'इस फ़ाइल से कुछ भी आयात नहीं किया जा सकता',
  'import.confirm': '{count} उत्पाद आयात करें',
  'import.running': 'आयात हो रहा है… बड़ी फ़ाइल में एक मिनट लग सकता है',
  'import.done': '{created} जोड़े गए और {updated} अपडेट हुए',
  'import.done.partial':
    '{created} जोड़े गए, {updated} अपडेट हुए; {skipped} छोड़े गए, {failed} सहेजे नहीं जा सके',
  'import.column.row': 'पंक्ति',
  'import.column.column': 'कॉलम',
  'import.column.problem': 'समस्या',
  'import.kind.error': 'त्रुटि',
  'import.kind.skipped': 'छोड़ा गया',
  'import.offline': 'आयात के लिए मास्टर पैनल चाहिए। लिंक लौटने पर फिर कोशिश करें।',
  'import.failed': 'आयात पूरा नहीं हो सका',
  'import.templateFailed': 'टेम्पलेट डाउनलोड नहीं हो सका',
  'import.another': 'एक और फ़ाइल आयात करें',
  'reports.column.orderCount': 'ऑर्डर',
  'reports.column.boxCount': 'बॉक्स',
  'reports.column.partyId': 'पार्टी आईडी',
  'reports.column.partyName': 'पार्टी',
  'reports.column.partyCode': 'कोड',
  'reports.export.totals': 'कुल',
  'party.field.city': 'City',
  // TODO(i18n-hi)
  'party.field.name': 'Party name',
  // TODO(i18n-hi)
  'party.field.notes': 'Notes',
  // TODO(i18n-hi)
  'party.field.phone': 'Phone',
  // TODO(i18n-hi)
  'party.field.taxId': 'Tax ID',
  // TODO(i18n-hi)
  'party.field.taxIdHint': "The party's GST number, if registered",
  // TODO(i18n-hi)
  'party.nameRequired': 'Enter the party name',
  // TODO(i18n-hi)
  'party.new.title': 'New party',
  // TODO(i18n-hi)
  'party.save': 'Save party',
  // TODO(i18n-hi)
  'party.saveChanges': 'Save changes',
  // TODO(i18n-hi)
  'party.saveHint': 'Available in every lead form the moment it saves — online or off',
  // TODO(i18n-hi)
  'party.saving': 'Saving…',
  // TODO(i18n-hi)
  'party.updated': '{name} updated',
  // TODO(i18n-hi)
  'partyAccess.action.cancel': 'Cancel',
  // TODO(i18n-hi)
  'partyAccess.action.export': 'Export',
  // TODO(i18n-hi)
  'partyAccess.action.save': 'Save',
  // TODO(i18n-hi)
  'partyAccess.addPerson': 'Add a person',
  // TODO(i18n-hi)
  'partyAccess.column.access': 'Access',
  // TODO(i18n-hi)
  'partyAccess.column.assignedTo': 'Assigned to',
  // TODO(i18n-hi)
  'partyAccess.column.city': 'City',
  // TODO(i18n-hi)
  'partyAccess.column.code': 'Code',
  // TODO(i18n-hi)
  'partyAccess.column.party': 'Party',
  // TODO(i18n-hi)
  'partyAccess.empty': 'No parties match this filter',
  // TODO(i18n-hi)
  'partyAccess.error.load': 'Could not load party access',
  // TODO(i18n-hi)
  'partyAccess.error.save': 'Could not save the assignments',
  // TODO(i18n-hi)
  'partyAccess.everyone': 'Everyone',
  // TODO(i18n-hi)
  'partyAccess.explainOpen':
    'Nobody is assigned, so everyone with the right role can see and work this party.',
  // TODO(i18n-hi)
  'partyAccess.explainRestricted':
    'Only the people below can see this party and its leads and orders. View can read; manage can also create and edit.',
  // TODO(i18n-hi)
  'partyAccess.filter.all': 'All',
  // TODO(i18n-hi)
  'partyAccess.filter.open': 'Open',
  // TODO(i18n-hi)
  'partyAccess.filter.restricted': 'Restricted',
  // TODO(i18n-hi)
  'partyAccess.intro':
    'A party nobody is assigned to is open to everyone. Assign someone and only they can reach it.',
  // TODO(i18n-hi)
  'partyAccess.level.manage': 'Manage',
  // TODO(i18n-hi)
  'partyAccess.level.view': 'View',
  // TODO(i18n-hi)
  'partyAccess.more': '+{count} more',
  // TODO(i18n-hi)
  'partyAccess.noAssignees': 'Nobody is assigned',
  // TODO(i18n-hi)
  'partyAccess.open': 'Open',
  // TODO(i18n-hi)
  'partyAccess.reload': 'Reload',
  // TODO(i18n-hi)
  'partyAccess.remove': 'Remove',
  // TODO(i18n-hi)
  'partyAccess.restricted': 'Restricted',
  // TODO(i18n-hi)
  'partyAccess.scope.all': 'All parties',
  // TODO(i18n-hi)
  'partyAccess.scope.assigned': 'My parties',
  // TODO(i18n-hi)
  'partyAccess.searchPlaceholder': 'Search parties',
  // TODO(i18n-hi)
  'partyAccess.staleSave': 'Somebody else changed this party’s access first. Reload to see it.',
  // TODO(i18n-hi)
  'partyAccess.summary': '{restricted} of {total} parties are restricted.',
  // TODO(i18n-hi)
  'partyAccess.title': 'Party access',
  'product.createFailed': 'उप-उत्पाद नहीं बनाया जा सका',
  'product.detail.editAction': 'उप-उत्पाद संपादित करें',
  // TODO(i18n-hi)
  'product.detail.size': 'Size',
  'product.edit.title': 'उप-उत्पाद संपादित करें',
  'product.group.identity': 'पहचान',
  'product.field.alias': 'Alias',
  // TODO(i18n-hi)
  'product.field.code': 'कोड',
  // --- Product photos: the strip and the crop editor -----------------------
  // TODO(i18n-hi)
  'photo.add': 'फ़ोटो जोड़ें',
  'photo.primary': 'मुख्य',
  'photo.setPrimary': 'मुख्य बनाएँ',
  'photo.moveEarlier': 'पहले करें',
  'photo.moveLater': 'बाद में करें',
  'photo.remove': 'फ़ोटो हटाएँ',
  'photo.removeConfirm.title': 'यह फ़ोटो हटाएँ?',
  'photo.removeConfirm.body': 'फ़ोटो और उससे बने सभी आकार मिट जाएँगे। इसे वापस नहीं लाया जा सकता।',
  'photo.dropHint': 'फ़ोटो यहाँ छोड़ें',
  'photo.change': 'फ़ोटो बदलें',
  'photo.addBrowseHint': 'फ़ोटो यहाँ छोड़ें, या चुनने के लिए क्लिक करें',
  'photo.gallery': 'और फ़ोटो',
  'photo.caption.edit': 'विवरण',
  'photo.caption.title': 'फ़ोटो का विवरण',
  'photo.caption.placeholder': 'यह फ़ोटो क्या दिखाती है',
  'photo.caption.help':
    'स्क्रीन रीडर इसे पढ़कर सुनाते हैं, और जहाँ भी फ़ोटो दिखती है वहाँ यही वैकल्पिक पाठ बनता है।',
  'photo.error.notAnImage': 'कोई इमेज फ़ाइल चुनें',
  'photo.error.tooLarge': '{maxMb} MB से छोटी इमेज चुनें',
  'photo.error.uploadFailed': 'फ़ोटो सहेजी नहीं जा सकी',
  'photo.error.updateFailed': 'फ़ोटो बदली नहीं जा सकी',
  'photo.error.removeFailed': 'फ़ोटो हटाई नहीं जा सकी',
  'photo.error.reorderFailed': 'फ़ोटो का क्रम बदला नहीं जा सका',
  'photo.editor.title': 'फ़ोटो संपादित करें',
  'photo.editor.titleQueued': 'फ़ोटो {index} / {total} संपादित करें',
  'photo.editor.loading': 'लोड हो रही है…',
  'photo.editor.aspect': 'आकार',
  'photo.editor.aspect.free': 'मुक्त',
  'photo.editor.aspect.original': 'मूल',
  'photo.editor.aspect.square': 'वर्ग',
  'photo.editor.aspect.landscape43': '4:3',
  'photo.editor.aspect.landscape32': '3:2',
  'photo.editor.aspect.portrait45': '4:5',
  'photo.editor.rotateLeft': 'बाएँ घुमाएँ',
  'photo.editor.rotateRight': 'दाएँ घुमाएँ',
  'photo.editor.straighten': 'सीधा करें',
  'photo.editor.rotate': 'घुमाएँ',
  'photo.editor.failed':
    'यह फ़ोटो नहीं खोली जा सकी। कुछ कैमरा फ़ॉर्मैट, जैसे iPhone का HEIC, यहाँ नहीं दिखाए जा सकते — इसे JPEG या PNG में सहेजकर दोबारा जोड़ें।',
  'photo.editor.reset': 'रीसेट',
  'photo.editor.output': 'परिणाम {width} × {height} px',
  'photo.editor.outputSmall':
    'परिणाम {width} × {height} px — इस उत्पाद के लिए संग्रहित {longEdge} px से छोटा, इसलिए सबसे बड़ा आकार पूरा नहीं भरेगा',
  'product.field.name': 'उप-उत्पाद का नाम',
  // TODO(i18n-hi)
  'product.field.size': 'Size',
  // TODO(i18n-hi)
  'product.field.weight': 'वज़न (kg)',
  'product.nameRequired': 'उप-उत्पाद का नाम लिखें',
  'product.new.title': 'नया उप-उत्पाद',
  'product.save': 'उप-उत्पाद सहेजें',
  // TODO(i18n-hi)
  'product.saveChanges': 'Save changes',
  // TODO(i18n-hi)
  'product.saveHint': 'Available in every lead form the moment it saves — online or off',
  // TODO(i18n-hi)
  'product.saving': 'Saving…',
  // TODO(i18n-hi)
  'product.updated': '{name} updated',
  // TODO(i18n-hi)
  'recycleBin.action.loadMore': 'Load older',
  // TODO(i18n-hi)
  'recycleBin.action.restore': 'Restore',
  // TODO(i18n-hi)
  'recycleBin.column.deletedAt': 'Deleted',
  // TODO(i18n-hi)
  'recycleBin.column.deletedBy': 'Deleted by',
  // TODO(i18n-hi)
  'recycleBin.column.detail': 'Detail',
  // TODO(i18n-hi)
  'recycleBin.column.label': 'Record',
  // TODO(i18n-hi)
  'recycleBin.column.type': 'Type',
  // TODO(i18n-hi)
  'recycleBin.deletedBy.panel': 'Office panel',
  // TODO(i18n-hi)
  'recycleBin.denied.description': 'Your role does not include {permission}.',
  // TODO(i18n-hi)
  'recycleBin.denied.title': 'You cannot see the recycle bin',
  // TODO(i18n-hi)
  'recycleBin.empty.description': 'Deleted records wait here until someone puts them back.',
  // TODO(i18n-hi)
  'recycleBin.empty.filtered.title': 'No deleted record matches these filters',
  // TODO(i18n-hi)
  'recycleBin.empty.title': 'Nothing deleted',
  // TODO(i18n-hi)
  'recycleBin.entity.custom_field_definition': 'Custom field',
  // TODO(i18n-hi)
  'recycleBin.entity.lead': 'Lead',
  // TODO(i18n-hi)
  'recycleBin.entity.option_list_item': 'Option value',
  // TODO(i18n-hi)
  'recycleBin.entity.order': 'Order',
  // TODO(i18n-hi)
  'recycleBin.entity.party': 'Party',
  'recycleBin.entity.product': 'उप-उत्पाद',
  'recycleBin.entity.product_category': 'उत्पाद',
  // TODO(i18n-hi)
  'recycleBin.entity.role': 'Role',
  // TODO(i18n-hi)
  'recycleBin.entity.user': 'Person',
  // TODO(i18n-hi)
  'recycleBin.error.load': 'Could not load the recycle bin',
  // TODO(i18n-hi)
  'recycleBin.error.restore': 'Could not restore that record',
  // TODO(i18n-hi)
  'recycleBin.error.restoreParent': 'Could not restore the records this one needs',
  // TODO(i18n-hi)
  'recycleBin.error.title': 'Could not load the recycle bin',
  // TODO(i18n-hi)
  'recycleBin.filter.allTypes': 'All types',
  // TODO(i18n-hi)
  'recycleBin.filter.anyone': 'Deleted by anyone',
  // TODO(i18n-hi)
  'recycleBin.filter.deletedBy': 'Deleted by',
  // TODO(i18n-hi)
  'recycleBin.filter.type': 'Record type',
  // TODO(i18n-hi)
  'recycleBin.filter.typeWithCount': '{type} ({count})',
  // TODO(i18n-hi)
  'recycleBin.refusal.nameHint':
    'A record still in use has the original one. Edit this if you prefer another.',
  // TODO(i18n-hi)
  'recycleBin.refusal.nameLabel': 'New name',
  // TODO(i18n-hi)
  'recycleBin.refusal.parentLine': '{type} · {label}',
  // TODO(i18n-hi)
  'recycleBin.refusal.parentsNotYours':
    'Someone allowed to restore those records has to put them back before this one can come back.',
  // TODO(i18n-hi)
  'recycleBin.refusal.parentsTitle': 'Still deleted',
  // TODO(i18n-hi)
  'recycleBin.refusal.restoreAs': 'Restore under this name',
  // TODO(i18n-hi)
  'recycleBin.refusal.restoreParents': 'Restore those first, then this',
  // TODO(i18n-hi)
  'recycleBin.refusal.title': 'Cannot restore {label} yet',
  // TODO(i18n-hi)
  'recycleBin.scope.everyone': 'Everyone’s deletions',
  // TODO(i18n-hi)
  'recycleBin.scope.everyone.hint': 'Showing what anyone in the company deleted.',
  // TODO(i18n-hi)
  'recycleBin.scope.own': 'Your deletions',
  // TODO(i18n-hi)
  'recycleBin.scope.own.hint': 'Showing what you deleted yourself.',
  // TODO(i18n-hi)
  'recycleBin.search.placeholder': 'Search deleted records…',
  // TODO(i18n-hi)
  'recycleBin.title': 'Recycle bin',
  // TODO(i18n-hi)
  'recycleBin.toast.restored': '{label} restored',
  // TODO(i18n-hi)
  'recycleBin.toast.restoredAs': '{label} restored as {name}',
  // TODO(i18n-hi)
  'reports.column.boxes': 'Boxes',
  // TODO(i18n-hi)
  'reports.column.city': 'City',
  // TODO(i18n-hi)
  'reports.column.code': 'Code',
  // TODO(i18n-hi)
  'reports.column.colour': 'Colour',
  // TODO(i18n-hi)
  'reports.column.converted': 'Converted',
  // TODO(i18n-hi)
  'reports.column.lost': 'Lost',
  // TODO(i18n-hi)
  'reports.column.month': 'Month',
  // TODO(i18n-hi)
  'reports.column.open': 'Still open',
  // TODO(i18n-hi)
  'reports.column.orders': 'Orders',
  // TODO(i18n-hi)
  'reports.column.parties': 'Parties',
  // TODO(i18n-hi)
  'reports.column.party': 'Party',
  // TODO(i18n-hi)
  'reports.column.quiet': 'Went quiet',
  // TODO(i18n-hi)
  'reports.kind.dispatches': 'डिस्पैच',
  'reports.kind.leadOutcomes': 'लीड परिणाम',
  'reports.kind.topParties': 'शीर्ष पार्टियाँ',
  'reports.dispatches.byColour': 'By colour',
  // TODO(i18n-hi)
  'reports.dispatches.byMonth': 'By month',
  // TODO(i18n-hi)
  'reports.dispatches.colours.empty.description':
    'Dispatched boxes carry a colour — none of the lines in this range did.',
  // TODO(i18n-hi)
  'reports.dispatches.colours.empty.title': 'No colours to break down',
  // TODO(i18n-hi)
  'reports.dispatches.empty.description':
    'Nothing was dispatched in these months. Try a wider range.',
  // TODO(i18n-hi)
  'reports.empty.title': 'No activity in this range',
  // TODO(i18n-hi)
  'reports.error.load': 'Could not load the report',
  // TODO(i18n-hi)
  'reports.export': 'Export CSV',
  // TODO(i18n-hi)
  'reports.leadOutcomes.byMonth': 'By month',
  // TODO(i18n-hi)
  'reports.leadOutcomes.empty.description':
    'No leads were raised in these months. Try a wider range.',
  // TODO(i18n-hi)
  'reports.leadOutcomes.quietNote':
    'A lead counts as gone quiet after {days} days with no movement.',
  // TODO(i18n-hi)
  'reports.noPermission.description': 'Ask an administrator to add {permission}.',
  // TODO(i18n-hi)
  'reports.noPermission.title': 'Reports are not part of your role',
  // TODO(i18n-hi)
  'reports.period.custom': 'Custom range',
  // TODO(i18n-hi)
  'reports.period.last12Months': 'Last 12 months',
  // TODO(i18n-hi)
  'reports.period.last3Months': 'Last 3 months',
  // TODO(i18n-hi)
  'reports.period.last6Months': 'Last 6 months',
  // TODO(i18n-hi)
  'reports.period.thisMonth': 'This month',
  // TODO(i18n-hi)
  'reports.range.caption': '{from} to {to} · {zone}',
  // TODO(i18n-hi)
  'reports.range.fromMonth': 'From month',
  // TODO(i18n-hi)
  'reports.range.period': 'Period',
  // TODO(i18n-hi)
  'reports.range.toMonth': 'To month',
  // TODO(i18n-hi)
  'reports.range.toMonthHint': 'Leave empty to run up to this month',
  // TODO(i18n-hi)
  'reports.stat.boxes': 'Boxes dispatched',
  // TODO(i18n-hi)
  'reports.stat.orders': 'Orders dispatched',
  // TODO(i18n-hi)
  'reports.tab.dispatches': 'Dispatches',
  // TODO(i18n-hi)
  'reports.tab.leadOutcomes': 'Lead outcomes',
  // TODO(i18n-hi)
  'reports.tab.topParties': 'Top parties',
  // TODO(i18n-hi)
  'reports.title': 'Reports',
  // TODO(i18n-hi)
  'reports.topParties.cities': 'Cities',
  // TODO(i18n-hi)
  'reports.topParties.cities.empty.description': 'None of these parties has a city recorded.',
  // TODO(i18n-hi)
  'reports.topParties.cities.empty.title': 'No cities to group by',
  // TODO(i18n-hi)
  'reports.topParties.empty.description': 'No party ordered in these months. Try a wider range.',
  // TODO(i18n-hi)
  'reports.topParties.orderedByCount': 'ऑर्डर संख्या के अनुसार शीर्ष {limit}।',
  // TODO(i18n-hi)
  'reports.topParties.parties': 'Parties',
  // TODO(i18n-hi)
  'settings.appearance.subtitle': 'Per-machine — never synced',
  // TODO(i18n-hi)
  'settings.appearance.title': 'Appearance',
  'settings.company.subtitle': 'पूरी कंपनी के लिए एक बार तय — हर मशीन के लिए नहीं।',
  'settings.company.saveFailed': 'वह सेटिंग सहेजी नहीं जा सकी',
  'settings.company.secretSet': 'सेट है',
  'settings.company.secretNotSet': 'सेट नहीं है',
  'settings.company.secretSave': 'सहेजें',
  'settings.vault.coverage': '{total} में से {stored} लोगों का पासवर्ड दिखाया जा सकता है',
  'settings.connection.company': 'Company',
  // TODO(i18n-hi)
  'settings.connection.description':
    'Office Panels normally connect automatically. Use these only for manual connection.',
  // TODO(i18n-hi)
  'settings.connection.masterAddress': 'Master address',
  // TODO(i18n-hi)
  'settings.connection.masterAddresses': 'Master addresses',
  // TODO(i18n-hi)
  'settings.connection.masterId': 'Master ID',
  // TODO(i18n-hi)
  'settings.connection.noAddress': 'No network address detected — port {port}',
  // TODO(i18n-hi)
  'settings.connection.passwordNote':
    'The pairing password is not stored in readable form and cannot be shown again. Office Panels already connected are unaffected.',
  // TODO(i18n-hi)
  'settings.connection.setupCompleted': 'Set up on',
  // TODO(i18n-hi)
  'settings.connection.state.connected': 'Connected',
  // TODO(i18n-hi)
  'settings.connection.state.connecting': 'Connecting…',
  // TODO(i18n-hi)
  'settings.connection.state.disconnected': 'Disconnected',
  // TODO(i18n-hi)
  'settings.connection.state.unpaired': 'Not paired',
  // TODO(i18n-hi)
  'settings.connection.title': 'Connection details',
  // TODO(i18n-hi)
  'settings.density.comfortable': 'Comfortable',
  // TODO(i18n-hi)
  'settings.density.compact': 'Compact',
  // TODO(i18n-hi)
  'settings.density.label': 'Density',
  // TODO(i18n-hi)
  'settings.density.large': 'Large',
  // TODO(i18n-hi)
  'settings.density.note': 'Row and control heights only — text size is the scale above.',
  // TODO(i18n-hi)
  'settings.language.label': 'भाषा',
  'settings.language.hint': 'भाषा बदलने पर यह पैनल फिर से लोड होगा।',
  'settings.machine.company': 'Company',
  // TODO(i18n-hi)
  'settings.machine.connection': 'Connection',
  // TODO(i18n-hi)
  'settings.machine.networkLink': 'Network link',
  // TODO(i18n-hi)
  'settings.machine.panel': 'Panel',
  // TODO(i18n-hi)
  'settings.machine.signedInAs': 'Signed in as',
  // TODO(i18n-hi)
  'settings.machine.signedInAsOffline': '{name} · {role} (signed in offline)',
  // TODO(i18n-hi)
  'settings.machine.title': 'This machine',
  // TODO(i18n-hi)
  'settings.motion.hint': "Also honours the system's reduced-motion setting",
  // TODO(i18n-hi)
  'settings.motion.label': 'Motion',
  // TODO(i18n-hi)
  'settings.motion.turnOff': 'Turn animation off',
  // TODO(i18n-hi)
  'settings.storage.database': 'Database',
  // TODO(i18n-hi)
  'settings.storage.free': 'Free space on this drive',
  // TODO(i18n-hi)
  'settings.storage.total': 'Total used by this software',
  // TODO(i18n-hi)
  'settings.storage.uploads': 'Images and files',
  // TODO(i18n-hi)
  'settings.sync.note':
    'Working offline is normal. Everything saves here first and syncs when the Master is reachable — nothing is ever lost to a dropped connection.',
  // TODO(i18n-hi)
  'settings.sync.title': 'Sync',
  // TODO(i18n-hi)
  'settings.theme.dark': 'Dark',
  // TODO(i18n-hi)
  'settings.theme.label': 'Theme',
  // TODO(i18n-hi)
  'settings.theme.light': 'Light',

  // --- The Settings screen's frame.
  // TODO(i18n-hi)
  'settings.title': 'Settings',
  'master.settings.subtitle':
    'आपकी कंपनी एक बार जो तय करती है, साथ ही इस PC की अपनी पसंद और जानकारी।',
  'office.settings.subtitle':
    'इस PC की अपनी पसंद, मास्टर से इसका कनेक्शन, और रखरखाव के साधन।',
  'settings.tab.appearance': 'Appearance',
  // TODO(i18n-hi)
  'settings.tab.shortcuts': 'Shortcuts',
  // TODO(i18n-hi)
  'settings.tab.company': 'Company',
  'settings.tab.leads': 'लीड',
  'settings.leads.sources.title': 'स्रोत',
  'settings.leads.sources.description':
    'लीड कहाँ से आ सकती है। नई लीड में सिर्फ़ ये मिलते हैं; किसी को हटाने पर वह पहले से दर्ज लीड पर बना रहता है।',
  // TODO(i18n-hi)
  'settings.tab.connection': 'Connection',
  // TODO(i18n-hi)
  'settings.tab.machine': 'This machine',
  // TODO(i18n-hi)
  'settings.tab.storage': 'Storage',
  // TODO(i18n-hi)
  'settings.tab.developer': 'Developer',
  // TODO(i18n-hi)
  'shell.noModules':
    "Your role does not include access to any of this panel's screens. Ask an administrator if you think that is wrong.",
  // TODO(i18n-hi)
  'shell.waitingFirstSync':
    'Waiting for the first sync with the Master Panel. Once it has happened, this panel keeps working whether or not the Master is reachable.',
  // TODO(i18n-hi)
  'signIn.action.signIn': 'Sign in',
  // TODO(i18n-hi)
  'signIn.action.signingIn': 'Signing in…',
  // TODO(i18n-hi)
  'signIn.error.default': 'Sign in failed',
  // TODO(i18n-hi)
  'signIn.field.password': 'Password',
  // TODO(i18n-hi)
  'signIn.field.username': 'Username',
  // TODO(i18n-hi)
  'signIn.subtitle': 'Enter the ID and password generated during setup.',
  // TODO(i18n-hi)
  'signin.errorFallback': 'Sign-in failed',
  // TODO(i18n-hi)
  'signin.offlineNotice':
    'The Master Panel is not reachable right now. You can still sign in if you have used this panel before — your work will be saved here and sent when the Master returns.',
  // TODO(i18n-hi)
  'signin.password': 'Password',
  // TODO(i18n-hi)
  'signin.submit': 'Sign in',
  // TODO(i18n-hi)
  'signin.submitting': 'Signing in…',
  // TODO(i18n-hi)
  'signin.subtitleFallback': 'Sign in to continue',
  // TODO(i18n-hi)
  'signin.chooseProfile': 'Who is using this panel?',
  // TODO(i18n-hi)
  'signin.notYou': 'Not you?',
  // TODO(i18n-hi)
  'signin.forgetProfile': 'Remove {name} from this panel',
  // TODO(i18n-hi)
  'signin.forgetConfirm':
    'Remove {name} from this panel? While the Master Panel is unreachable they will not be able to sign in here until it is back.',
  // TODO(i18n-hi)
  'signin.forgetFailed': 'Could not remove that person from this panel',
  // TODO(i18n-hi)
  'storage.title': 'Where this panel keeps its files',
  // TODO(i18n-hi)
  'storage.change': 'Change',
  // TODO(i18n-hi)
  'storage.free': 'इस ड्राइव पर {size} खाली',
  'storage.folder': 'Folder',
  // TODO(i18n-hi)
  'storage.browse': 'Browse…',
  // TODO(i18n-hi)
  'storage.move': 'Move the files here',
  // TODO(i18n-hi)
  'storage.help':
    'Everything this panel has saved is copied to the new folder. Queued work that has not reached the Master goes with it.',
  // TODO(i18n-hi)
  'storage.moved': 'Moved {count} files.',
  // TODO(i18n-hi)
  'storage.failed': 'Could not move this panel’s files',
  'storage.refused.driveRoot':
    '{folder} ड्राइव का सबसे ऊपरी फ़ोल्डर है। इसके बजाय उस ड्राइव पर कोई फ़ोल्डर चुनें या बनाएँ।',
  'storage.refused.homeFolder':
    '{folder} किसी उपयोगकर्ता का होम फ़ोल्डर है। इसके बजाय उसके अंदर कोई फ़ोल्डर चुनें या बनाएँ।',
  'storage.refused.notEmpty':
    '{folder} में पहले से ऐसी फ़ाइलें हैं जो इस पैनल की नहीं हैं, जैसे {example}। कोई खाली या नया फ़ोल्डर चुनें।',
  'signin.username': 'Username',
  // TODO(i18n-hi)
  'splash.error.timeout': 'The server did not answer in time.',
  // TODO(i18n-hi)
  'splash.error.unreachable': 'Could not reach the server. It may still be starting up.',
  // TODO(i18n-hi)
  'splash.step.assets': 'Preparing the workspace',
  // TODO(i18n-hi)
  'splash.step.ready': 'Ready',
  // TODO(i18n-hi)
  'splash.step.server': 'Contacting the server',
  // TODO(i18n-hi)
  'splash.step.session': 'Restoring your session',
  // TODO(i18n-hi)
  'sync.flushNow': 'Sync now',
  // TODO(i18n-hi)
  'sync.flushing': 'Syncing…',
  // TODO(i18n-hi)
  'sync.lastSuccessful': 'Last successful sync',
  // TODO(i18n-hi)
  'sync.lowStock': 'Products low on stock',
  // TODO(i18n-hi)
  'sync.pairedServer': 'Paired server',
  // TODO(i18n-hi)
  'sync.panelsOnline': 'Panels online',
  // TODO(i18n-hi)
  'sync.popoverTitle.conflict': 'Conflicts to review',
  // TODO(i18n-hi)
  'sync.popoverTitle.syncing': 'Syncing',
  // TODO(i18n-hi)
  'sync.refusedChanges': 'Refused changes',
  // TODO(i18n-hi)
  'sync.synced': 'Synced',
  'sync.statusLabel': 'सिंक स्थिति: {status}',
  // TODO(i18n-hi)
  'sync.syncing': 'Syncing {count}',
  // TODO(i18n-hi)
  'unit.product': 'product',
  // TODO(i18n-hi)
  'unit.products': 'products',
  // TODO(i18n-hi)
  'updates.ahead': 'Newer than this Master',
  // TODO(i18n-hi)
  'updates.allMatch': 'Every panel is on {version}, the same version as this Master.',
  // TODO(i18n-hi)
  'updates.behind': 'Different version',
  // TODO(i18n-hi)
  'updates.dataStays':
    'Your data stays exactly where it is. The setup replaces the program only — parties, leads, orders and settings are untouched.',
  // TODO(i18n-hi)
  'updates.downloading': 'Getting it from the Master…',
  // TODO(i18n-hi)
  'updates.howBody':
    'Copy a new build into the releases folder on this PC. This Master installs its own from there; every Office Panel pulls its own copy from this Master over the office network. Update the Master first — a panel on the previous version keeps working and syncing in the meantime.',
  // TODO(i18n-hi)
  'updates.howHint':
    'This network has no internet by design, so nothing here checks an update server or downloads anything on its own.',
  // TODO(i18n-hi)
  'updates.howTitle': 'How updates reach this software',
  // TODO(i18n-hi)
  'updates.installFailed': 'The update could not be prepared',
  // TODO(i18n-hi)
  'updates.installNow': 'Install now',
  // TODO(i18n-hi)
  'updates.launchRefused':
    'The update did not start, and this version is still running. Try again, or see why in the log: Help → Open log folder.',
  // TODO(i18n-hi)
  'updates.launching': 'Starting the installer…',
  // TODO(i18n-hi)
  'updates.masterVersion': 'Master version',
  // TODO(i18n-hi)
  'updates.needsPermission':
    'Ask an administrator to install this — it needs the "Manage settings" permission.',
  // TODO(i18n-hi)
  'updates.noFolder': 'No releases folder on this PC yet, so there is nothing to install from.',
  // TODO(i18n-hi)
  'updates.noRelease': 'The releases folder is there, but no build has been put in it yet.',
  // TODO(i18n-hi)
  'updates.officeReady':
    'Office build {version} is ready on this Master. Each panel can install it from its own App update screen.',
  // TODO(i18n-hi)
  'updates.panel.behindBody':
    'The Master is on {version} and this panel is on an older build. Nothing is wrong — it keeps working and syncing exactly as it does now. When a matching build is published on the Master it will appear here to install.',
  // TODO(i18n-hi)
  'updates.panel.matchBody': 'This panel is on the same version as the Master. Nothing to do.',
  // TODO(i18n-hi)
  'updates.panel.offerBody':
    'Version {version} is waiting on the Master. Installing it copies the file to this PC first, so nothing depends on the network once it starts. Anything this panel has queued offline is kept.',
  // TODO(i18n-hi)
  'updates.panel.unknownBody':
    'This panel has not heard from the Master since it started, so it cannot say which version the Master is on. It will once the link is back.',
  // TODO(i18n-hi)
  'updates.panelVersion': 'Panel version',
  // TODO(i18n-hi)
  'updates.panelsBehind': 'On a different version',
  // TODO(i18n-hi)
  'updates.panelsTitle': 'Office panel versions',
  // TODO(i18n-hi)
  'updates.panelsTracked': 'Office panels paired',
  // TODO(i18n-hi)
  'updates.readyLabel': 'Ready to install',
  // TODO(i18n-hi)
  'updates.runByHand': 'The file is ready. Run it yourself from:',
  // TODO(i18n-hi)
  'updates.someBehind':
    '{count} panel(s) are on a different version from this Master ({version}). They keep working — a panel is never blocked for being out of step.',
  // TODO(i18n-hi)
  'updates.someUnknown':
    '{count} panel(s) have not reported a version yet. They will the next time they connect.',
  // TODO(i18n-hi)
  'updates.statusLabel': 'Against the Master',
  // TODO(i18n-hi)
  'updates.systemPackageBody':
    'This copy was not started from an AppImage, so it cannot replace itself. If it was installed from a .deb package, only the system’s package manager can update it: get the new .deb package, close this window, install it the way this one was installed, and open OrderBook again. The database and every setting stay exactly where they are.',
  // TODO(i18n-hi)
  'updates.table.version': 'Version',
  // TODO(i18n-hi)
  'updates.thisMachine': 'This Master',
  // TODO(i18n-hi)
  'updates.thisPanel': 'This panel',
  // TODO(i18n-hi)
  'updates.unknown': 'Unknown',
  // TODO(i18n-hi)
  'updates.upToDate': 'Up to date',
  // TODO(i18n-hi)
  'updates.upToDateBody': 'This is the newest build in the releases folder. Nothing to do.',
  // TODO(i18n-hi)
  'updates.verifying': 'Checking the file…',
  // TODO(i18n-hi)
  'screen.reset': 'Reset this screen',
  // TODO(i18n-hi)
  'screen.resetHint':
    'Clear the filters, scroll and unsaved entry on this screen and load it fresh.',
  // TODO(i18n-hi)
  'lead.add.discardConfirm': 'Discard this lead and start over?',
  // TODO(i18n-hi)
  'settings.scale.label': 'UI scale',
  // TODO(i18n-hi)
  'settings.scale.reset': 'Reset',
  'settings.scale.smaller': 'छोटा',
  'settings.scale.larger': 'बड़ा',
  // TODO(i18n-hi)
  'settings.scale.note': 'Root {size} — this screen resizes live',
  // TODO(i18n-hi)
  'keys.command.toggleSidebar': 'Toggle sidebar',
  // TODO(i18n-hi)
  'keys.command.find': 'इस स्क्रीन में खोजें',

  // --- Developer mode ---
  // TODO(i18n-hi)
  'developer.unlockFailed': 'Unlock failed',
  // TODO(i18n-hi)
  'developer.unlocked.title': 'Developer mode is active',
  // TODO(i18n-hi)
  'developer.unlocked.locksIn': 'Locks in {time}',
  // TODO(i18n-hi)
  'developer.lock': 'Lock',
  // TODO(i18n-hi)
  'developer.locked.title': 'Developer Mode',
  // TODO(i18n-hi)
  'developer.locked.description':
    'Enter the developer password to access maintenance tools. This is not a user account — it is a shared key documented with the software.',
  // TODO(i18n-hi)
  'developer.locked.passwordLabel': 'Developer password',
  // TODO(i18n-hi)
  'developer.locked.hint': 'Found in docs/DEVELOPER_MODE.md',
  // TODO(i18n-hi)
  'developer.unlock': 'Unlock',
  // TODO(i18n-hi)
  'developer.confirm.typeWord': 'Type {word} to confirm',

  // --- The tools themselves.
  // TODO(i18n-hi)
  'developer.tool.seed.title': 'Test users',
  // TODO(i18n-hi)
  'developer.tool.seed.description':
    'Creates three sign-ins — admin, management and office — with the fixed passwords documented beside the software, and re-arms them with those passwords if they already exist. If a user called admin is already here, its password and its display name are overwritten and everyone signed in as it is signed out.',
  // TODO(i18n-hi)
  'developer.tool.seed.action': 'Seed test users',
  // TODO(i18n-hi)
  'developer.tool.seed.done': 'Test users are ready',
  // TODO(i18n-hi)
  'developer.tool.seed.username': 'Username',
  // TODO(i18n-hi)
  'developer.tool.seed.password': 'Password',
  // TODO(i18n-hi)
  'developer.tool.seed.tier': 'Tier',
  // TODO(i18n-hi)
  'developer.tool.seed.outcome': 'Outcome',
  // TODO(i18n-hi)
  'developer.tool.seed.outcomeCreated': 'Created',
  // TODO(i18n-hi)
  'developer.tool.seed.outcomeReset': 'Password reset',
  // TODO(i18n-hi)
  'developer.tool.seed.pairingPassword':
    'This seed had to run first-time setup itself. The pairing password it generated is shown once, here, and cannot be shown again:',
  // TODO(i18n-hi)
  'developer.tool.resetAll.title': 'Erase everything',
  // TODO(i18n-hi)
  'developer.tool.resetAll.description':
    'Returns this Master to the state it was in before it was ever set up. There is no undo, and no backup is taken on the way.',
  // TODO(i18n-hi)
  'developer.tool.resetAll.action': 'Erase everything',
  // TODO(i18n-hi)
  'developer.tool.resetAll.confirmTitle': 'Erase this installation?',
  // TODO(i18n-hi)
  'developer.tool.resetAll.confirmHint':
    'What stays: the database server itself, the log files, and the data-folder location.',
  // TODO(i18n-hi)
  'developer.tool.resetAll.detail.records': 'Every record — parties, products, leads and orders',
  // TODO(i18n-hi)
  'developer.tool.resetAll.detail.files': 'Uploads',
  // TODO(i18n-hi)
  'developer.tool.resetAll.detail.people': 'Users and roles',
  // TODO(i18n-hi)
  'developer.tool.resetAll.detail.settings': 'Company settings',
  // TODO(i18n-hi)
  'developer.tool.resetAll.detail.pairings': 'Office Panel pairings',
  // TODO(i18n-hi)
  'developer.tool.resetAll.detail.vault': 'The password vault key',
  // TODO(i18n-hi)
  'developer.tool.resetAll.done': 'Erased — going back to first-run setup',
  // TODO(i18n-hi)
  'developer.tool.resetPanel.title': 'Reset this panel',
  // TODO(i18n-hi)
  'developer.tool.resetPanel.description':
    'Unpairs this Office Panel and throws away everything it holds. The Master and its data are untouched.',
  // TODO(i18n-hi)
  'developer.tool.resetPanel.action': 'Reset this panel',
  // TODO(i18n-hi)
  'developer.tool.resetPanel.confirmTitle': 'Reset this panel?',
  // TODO(i18n-hi)
  'developer.tool.resetPanel.confirmHint':
    'What stays: the data-folder location. Everything else comes back from the Master once this panel is paired again.',
  // TODO(i18n-hi)
  'developer.tool.resetPanel.detail.pairing': 'The pairing with the Master',
  // TODO(i18n-hi)
  'developer.tool.resetPanel.detail.users': 'Cached users and remembered faces',
  // TODO(i18n-hi)
  'developer.tool.resetPanel.detail.queue':
    'The offline queue — anything saved here and not yet sent',
  // TODO(i18n-hi)
  'developer.tool.resetPanel.detail.snapshot': 'The cached snapshot and product images',
  // TODO(i18n-hi)
  'developer.tool.resetPanel.done': 'Panel reset — going back to the connection screen',

  // TODO(i18n-hi)
  'developer.tool.uninstall.title': 'Uninstall OrderBook',
  // TODO(i18n-hi)
  'developer.tool.uninstall.description':
    'Removes this panel from this computer: the program, its shortcuts, its registry entries and the firewall rules its installer added. The window closes and the rest happens without it.',
  // TODO(i18n-hi)
  'developer.tool.uninstall.action': 'Uninstall',
  // TODO(i18n-hi)
  'developer.tool.uninstall.deleteData': 'Also delete all OrderBook data on this computer',
  // TODO(i18n-hi)
  'developer.tool.uninstall.confirmWord': 'DELETE',
  // TODO(i18n-hi)
  'developer.tool.uninstall.confirmTitle': 'Uninstall and delete the data?',
  // TODO(i18n-hi)
  'developer.tool.uninstall.confirmHint':
    'This computer will keep nothing. Take a backup first if anybody still needs these records.',
  // TODO(i18n-hi)
  'developer.tool.uninstall.detail.program': 'The program, its shortcuts and its firewall rules',
  // TODO(i18n-hi)
  'developer.tool.uninstall.detail.data': 'The database, uploads and settings',
  // TODO(i18n-hi)
  'developer.tool.uninstall.browserOnly':
    'Open this panel in its desktop app to uninstall it — a browser tab cannot remove a program from the computer it is looking at.',
  // TODO(i18n-hi)
  'developer.tool.uninstall.refused': 'Uninstall cancelled — nothing was removed',
  // TODO(i18n-hi)
  'action.backToList': 'Back to list',
  // TODO(i18n-hi)
  'dashboard.asOf': 'Figures as of {when}',
  // TODO(i18n-hi)
  'dashboard.asOf.stale': 'Figures from the last time the Master was reachable · {when}',
  // TODO(i18n-hi)
  'dashboard.pipeline.title': 'Lead pipeline',
  // TODO(i18n-hi)
  'lead.add.draft.col.quantity': 'Quantity',
  // TODO(i18n-hi)
  'lead.add.draft.editing': 'editing saved product',
  // TODO(i18n-hi)
  'lead.add.draft.colour': 'रंग',
  'lead.add.draft.grade': 'ग्रेड',
  'lead.add.draft.gradeEmpty': 'अभी कोई ग्रेड सूची में नहीं है — इन्हें सेटिंग्स → फ़ील्ड्स में जोड़ें।',
  'lead.add.draft.hintPieces': 'इस कार्ड पर {count} पीस — लीड में जोड़ें',
  // TODO(i18n-hi)
  'lead.add.draft.hintPackaging': 'Choose packaging to save this product',
  // TODO(i18n-hi)
  'lead.add.draft.hintQuantity': 'कम से कम एक वेरिएंट की मात्रा दर्ज करें',
  // TODO(i18n-hi)
  'lead.add.draft.new': 'new product',
  // TODO(i18n-hi)
  'lead.add.draft.packaging': 'Packaging',
  'lead.add.draft.packagingEmpty': 'No packaging listed yet — add it under Settings → Fields.',
  // TODO(i18n-hi)
  'lead.add.draft.quantityTitle': 'मात्रा — पीस',
  // TODO(i18n-hi)
  'lead.add.draft.saveChanges': 'Save changes',
  // TODO(i18n-hi)
  'lead.add.draft.saveProduct': 'Save product',
  // TODO(i18n-hi)
  'lead.add.errors.draftOpen': 'Save or cancel the open product first',
  // TODO(i18n-hi)
  'lead.add.followUp.inThreeDays': 'In 3 days',
  // TODO(i18n-hi)
  'lead.add.followUp.nextWeek': 'Next week',
  // TODO(i18n-hi)
  'lead.add.followUp.tomorrow': 'Tomorrow',
  // TODO(i18n-hi)
  'lead.add.line.grade': 'Grade',
  // TODO(i18n-hi)
  'lead.add.line.modify': 'Modify',
  'lead.add.line.modifyProduct': '{product} में बदलाव करें',
  'lead.add.line.removeProduct': '{product} हटाएँ',
  // TODO(i18n-hi)
  'lead.add.notes.placeholder': 'Anything the next person should know…',
  // TODO(i18n-hi)
  'lead.add.products.col.code': 'कोड',
  'lead.add.products.col.product': 'उप-उत्पाद',
  // TODO(i18n-hi)
  'lead.add.products.overFree': 'over free stock',
  // TODO(i18n-hi)
  'lead.add.progress': '{done} of {total} required steps',
  // TODO(i18n-hi)
  'lead.add.status.draft': 'Save or cancel the open product first',
  // TODO(i18n-hi)
  'lead.add.status.party': 'Select a party to continue',
  // TODO(i18n-hi)
  'lead.add.status.products': 'Add at least one product',
  // TODO(i18n-hi)
  'lead.add.step.notesHint': 'optional — can be added later',
  // TODO(i18n-hi)
  'lead.add.step.required': 'required',
  // TODO(i18n-hi)
  'lead.add.step.source': 'Source platform',
  // TODO(i18n-hi)
  'lead.add.summary.count': '{count} लाइनें · {qty} पीस',
  // TODO(i18n-hi)
  'lead.add.summary.empty': 'Nothing added yet',
  // TODO(i18n-hi)
  'lead.add.party.create': '+ Create a new party',
  // TODO(i18n-hi)
  'lead.add.party.ownRates': 'पार्टी-वार नाम लागू',
  // TODO(i18n-hi)
  'lead.add.party.placeholder': 'Select party — name, code or phone',
  // TODO(i18n-hi)
  'lead.add.draft.title': 'Details for this product',
  // TODO(i18n-hi)
  'lead.add.followUp.label': 'Follow up',
  // TODO(i18n-hi)
  'lead.add.line.noPackaging': 'no packaging',
  // TODO(i18n-hi)
  'lead.add.products.clear': 'Clear selection',
  // TODO(i18n-hi)
  'lead.add.products.pickedHint': 'Enter मात्रा, पैकेजिंग और ग्रेड से होकर Add product पर जाता है, जहाँ Enter से यह उप-उत्पाद जुड़कर सूची पर लौटता है; Shift+Q से जुड़कर अगले उत्पाद पर जाता है।',
  // TODO(i18n-hi)
  'lead.add.products.searchAdds': 'खोज से और जोड़ें',
  // TODO(i18n-hi)
  'lead.add.products.searchFirst': 'उत्पाद चुनें, फिर उप-उत्पाद — कम से कम एक',
  // TODO(i18n-hi)
  'lead.add.saved': 'Lead saved — {id} syncs when the Master is reachable',
  // TODO(i18n-hi)
  'lead.add.source.label': 'Source',
  // TODO(i18n-hi)
  'lead.add.summary.countOne': '{count} लाइन · {qty} पीस',
  // TODO(i18n-hi)
  'lead.add.line.ofFree': 'of {free} free',
  // TODO(i18n-hi)
  'lead.add.panel.clear': 'Clear',
  // TODO(i18n-hi)
  'lead.add.panel.countFiltered': '{shown} of {total}',
  // TODO(i18n-hi)
  'lead.add.panel.emptyFiltered': 'No added product matches that search.',
  // TODO(i18n-hi)
  'lead.add.panel.emptyNone': 'Nothing added yet — search a product on the left to add it here.',
  // TODO(i18n-hi)
  'lead.add.panel.removeSelected': 'Remove {count} products',
  // TODO(i18n-hi)
  'lead.add.panel.removeSelectedOne': 'Remove {count} product',
  // TODO(i18n-hi)
  'lead.add.panel.search': 'Search added products',
  // TODO(i18n-hi)
  'lead.add.panel.select': 'Select {product}',
  // TODO(i18n-hi)
  'lead.add.panel.selectAll': 'Select all shown',
  // TODO(i18n-hi)
  'lead.add.panel.selected': '{count} selected',
  // TODO(i18n-hi)
  'lead.add.panel.title': 'Added products',
  // TODO(i18n-hi)
  'lead.add.panel.truncated': 'Showing the first {shown} — narrow the search to see the rest',
  // TODO(i18n-hi)
  'lead.add.draft.showOptions': 'Show {field} options',
  // TODO(i18n-hi)
  'validation.developer.administratorRequired':
    'कैटलॉग लोड करने से पहले एक व्यवस्थापक सेट करें',
  'validation.developer.sampleDataPresent': "Sample data is already on this Master. Erase everything first to seed it again.",
  // TODO(i18n-hi)
  'developer.tool.sample.title': "Sample data",
  // TODO(i18n-hi)
  'developer.tool.sample.description': 'इस Master को छह महीने के एक छोटे सैनिटरीवेयर व्यापार से भरता है — Swisware कैटलॉग, बेचे जाने वाले मॉडलों पर वज़न, पार्टियाँ, प्रति वेरिएंट स्टॉक, हर चरण पर लीड, चालू और भेजे गए ऑर्डर, टिप्पणियाँ, पार्टी-वार रिकॉर्ड, पार्टी एक्सेस, कस्टम फ़ील्ड और Recycle Bin में कुछ रिकॉर्ड — ताकि हर स्क्रीन पर कुछ दिखे। पहले तीन टेस्ट उपयोगकर्ता बनाता है, ठीक "Seed test users" की तरह। प्रति इंस्टॉलेशन एक बार चलता है; फिर से शुरू करने के लिए सब मिटाएँ।',
  // TODO(i18n-hi)
  'developer.tool.sample.action': "Seed sample data",
  // TODO(i18n-hi)
  'developer.tool.sample.done': "Sample data is ready — open the dashboard",
  // TODO(i18n-hi)
  'developer.tool.sample.span': "History runs from {from} to {to}.",
  // TODO(i18n-hi)
  'developer.tool.sample.what': "Created",
  // TODO(i18n-hi)
  'developer.tool.sample.howMany': "Count",
  // TODO(i18n-hi)
  'developer.tool.sample.count.parties': "Parties",
  // TODO(i18n-hi)
  'developer.tool.sample.count.products': "Products",
  // TODO(i18n-hi)
  'developer.tool.sample.count.images': "Product photos",
  // TODO(i18n-hi)
  'developer.tool.sample.count.stockMovements': "Stock movements",
  // TODO(i18n-hi)
  'developer.tool.sample.count.leads': "Leads",
  // TODO(i18n-hi)
  'developer.tool.sample.count.orders': "Orders",
  // TODO(i18n-hi)
  'developer.tool.sample.count.dispatched': "Orders dispatched",
  // TODO(i18n-hi)
  'developer.tool.sample.count.remarks': "Remarks",
  // TODO(i18n-hi)
  'developer.tool.sample.count.optionValues': "Option list values",
  // TODO(i18n-hi)
  'developer.tool.sample.count.customFields': "Custom fields",
  // TODO(i18n-hi)
  'developer.tool.sample.count.partyVariants': 'पार्टी-वार रिकॉर्ड',
  // TODO(i18n-hi)
  'developer.tool.sample.count.partyAssignments': "Party access assignments",
  // TODO(i18n-hi)
  'developer.tool.sample.count.deleted': "In the Recycle Bin",

  // --- Product model → variant restructure (2026-09): categories, variants, weights ---
  'lead.add.products.categoryPlaceholder': 'उत्पाद का नाम या कोड लिखें — जैसे OPT, one piece toilet',
  'lead.add.products.productPlaceholder': '{category} का उप-उत्पाद — सूची छोटी करने के लिए लिखें, जैसे 41, Magenta',
  'lead.add.products.changeCategory': 'उत्पाद बदलें',
  'lead.add.products.categoryHint': 'नाम या कोड से उत्पाद चुनें; उसके उप-उत्पाद उसके बाद आते हैं।',
  'lead.add.products.productHint': 'उप-उत्पाद चुनें। खाली बॉक्स पर Shift+Q से यह उत्पाद पूरा होता है; Backspace से उत्पाद बार पर वापस जाएँ।',
  'lead.add.products.col.category': 'उत्पाद',
  'lead.add.products.col.variant': 'वेरिएंट',
  'lead.add.products.col.weight': 'वज़न',
  'lead.add.products.variantCount': '{count} वेरिएंट',
  'lead.add.products.noCategory': 'इस नाम या कोड से कोई उत्पाद नहीं मिला।',
  'lead.add.products.noProduct': 'इस उत्पाद का कोई उप-उत्पाद इससे मेल नहीं खाता।',
  'lead.add.flow.completeSubProduct': 'उप-उत्पाद पूरा करें',
  'lead.add.flow.addColour': 'रंग जोड़ें',
  'lead.add.flow.addColourPlaceholder': 'रंग लिखें — Enter से जुड़ता है; खाली बॉक्स पर Enter से मात्रा पर जाएँ',
  'lead.add.draft.hintColour': 'कम से कम एक रंग जोड़ें',
  'lead.add.draft.removeColour': 'रंग {colour} हटाएँ',
  'lead.add.review.title': 'लीड जाँचें',
  'lead.add.review.hint': 'Ctrl+Enter से सहेजें; Esc से फ़ॉर्म पर वापस जाएँ।',
  'lead.add.draft.quantityTitleVariants': 'मात्रा — प्रति वेरिएंट पीस',
  'lead.add.line.qtyShort': '{count} पीस',
  'lead.add.line.lineWeight': 'इस लाइन पर {kg}',
  'lead.add.summary.weight': 'कुल {kg}',
  'lead.add.summary.noWeight': '{count} लाइनों का वज़न नहीं है — उत्पाद पर दर्ज करें',
  'lead.add.summary.noWeightOne': '{count} लाइन का वज़न नहीं है — उत्पाद पर दर्ज करें',
  'lead.list.col.qty': 'मात्रा',
  'lead.list.col.weight': 'वज़न',
  'lead.detail.line.weight': '{each} प्रति · इस लाइन पर {total}',
  'lead.detail.totalWeight': 'कुल वज़न',
  'lead.detail.linesWithoutWeight': '{count} लाइनों का वज़न नहीं',
  'lead.detail.linesWithoutWeightOne': '{count} लाइन का वज़न नहीं',
  'orders.column.code': 'कोड',
  'orders.column.variant': 'वेरिएंट',
  'orders.column.qty': 'मात्रा',
  'orders.column.lineWeight': 'लाइन वज़न',
  'orders.detail.linesWithoutWeight': '{count} लाइनों का वज़न अभी नहीं है — गणना में वे शामिल नहीं',
  'orders.detail.linesWithoutWeightOne': '{count} लाइन का वज़न अभी नहीं है — गणना में वह शामिल नहीं',
  'catalog.products.column.category': 'उत्पाद',
  'catalog.products.column.codes': 'कोड',
  'catalog.products.column.weight': 'वज़न',
  'catalog.products.variantCount': '{count} वेरिएंट · {first}…',
  'product.weight.missing': 'वज़न नहीं',
  'product.weight.missingShort': 'नहीं',
  'product.weight.range': '{low} – {high}',
  'product.field.category': 'उत्पाद',
  'product.field.categoryHint': 'यह जिस उत्पाद के अंतर्गत आता है। नए उत्पाद उत्पाद पृष्ठ पर जोड़े जाते हैं।',
  'product.field.weightHint': 'प्रति पीस। तौलने तक खाली छोड़ें — यह “नहीं” दिखेगा, शून्य नहीं।',
  'product.group.colours': 'रंग',
  'product.multiColour.label': 'हर रंग में बनता है?',
  'product.multiColour.no': 'नहीं — केवल ऊपर के वेरिएंट',
  'product.multiColour.yes': 'हाँ — रंग सूची का कोई भी रंग',
  'product.multiColour.noHint': 'लीड लाइन वेरिएंट को जैसा है वैसा दर्ज करती है।',
  'product.multiColour.yesHint': 'इस उत्पाद की लीड लाइन पर रंग सूची (सेटिंग्स → फ़ील्ड → रंग) से एक रंग भी चुना जा सकता है।',
  'product.field.sizePlaceholder': 'जैसे 18x12, L-27 B-15 H-26',
  'product.group.codes': 'कोड और वज़न',
  'product.variants.hasVariants': 'वेरिएंट (रंग या पैटर्न) में आता है?',
  'product.variants.no': 'नहीं — एक कोड',
  'product.variants.yes': 'हाँ — हर वेरिएंट का अपना कोड',
  'product.variants.noHint': 'एक उत्पाद, एक कोड, एक वज़न।',
  'product.variants.yesHint': 'हर रंग या पैटर्न लीड पर अपनी लाइन है, अपने कोड और वज़न के साथ।',
  'product.variants.col.label': 'रंग',
  'product.variants.col.code': 'कोड',
  'product.variants.col.weight': 'वज़न (kg)',
  'product.variants.labelPlaceholder': 'जैसे White, Vitrosa 41',
  'product.variants.add': '+ वेरिएंट जोड़ें',
  'product.variants.remove': 'वेरिएंट {label} हटाएँ',
  'product.variants.weightHint': 'वज़न प्रति पीस है। खाली वज़न दर्ज होने तक हर लीड पर “नहीं” दिखता है।',
  'product.detail.category': 'उत्पाद',
  'product.detail.detailsTitle': 'विवरण',
  'product.detail.photoTitle': 'फ़ोटो',
  'product.detail.code': 'कोड',
  'product.detail.weight': 'वज़न',
  'unit.pieces': 'पीस',
  'unit.line': 'लाइन',
  'unit.lines': 'लाइनें',

  // --- Master panel: inventory per variant, catalogue loader ---
  'inventory.table.brand': 'ब्रांड',
  'inventory.table.subProduct': 'उप-उत्पाद',
  'inventory.table.size': 'साइज़',
  'inventory.table.colour': 'रंग',
  'inventory.table.weight': 'वज़न',
  'inventory.table.min': 'न्यूनतम',
  'inventory.table.max': 'अधिकतम',
  'inventory.minLevelLabel': '{product} {variant} का न्यूनतम स्टॉक',
  'inventory.maxLevelLabel': '{product} {variant} का अधिकतम स्टॉक',
  'inventory.piecesFree': '{count} पीस उपलब्ध',
  'inventory.piecesOnHand': '{count} पीस स्टॉक में',
  'inventory.field.variant': 'वेरिएंट',
  'inventory.field.variantPlaceholder': 'वेरिएंट चुनें…',
  'inventory.field.pieces': 'पीस',
  'inventory.movements.table.variant': 'वेरिएंट',
  'leadsOrders.leads.column.weight': 'वज़न',
  'leadsOrders.linesWithoutWeight': '{count} लाइनों का वज़न अभी नहीं है — आँकड़े में वे शामिल नहीं',
  'developer.tool.swisware.title': 'SWISWARE कैटलॉग लोड करें',
  'developer.tool.swisware.description': 'मास्टर के साथ आया SWISWARE कैटलॉग लोड करता है: उसका ब्रांड, रंगों की सूची, हर उत्पाद अपने कोड के साथ और हर उप-उत्पाद कैटलॉग के क्रम में — वज़न प्रशासक के भरने के लिए खाली। कुछ भी हटाया नहीं जाता, और दोबारा दबाना सुरक्षित है: अपने उत्पाद में पहले से मौजूद उप-उत्पाद छोड़ दिया जाता है।',
  'developer.tool.swisware.action': 'कैटलॉग लोड करें',
  'developer.tool.swisware.done': 'कैटलॉग लोड हुआ',
  'developer.tool.swisware.loaded': 'कैटलॉग उत्पाद मास्टर में है। वज़न भरने के लिए Office पैनल का कैटलॉग खोलें।',
  'developer.tool.swisware.alreadyPresent': 'लोड करने को कुछ नहीं — कैटलॉग का हर उप-उत्पाद पहले से उत्पाद मास्टर में है।',
  'developer.tool.swisware.count.products': 'बने उत्पाद',
  'developer.tool.swisware.count.subProducts': 'बने उप-उत्पाद',
  'developer.tool.swisware.count.colours': 'जोड़े गए रंग',
  'developer.tool.swisware.count.skipped': 'पहले से मौजूद उप-उत्पाद, अछूते',
  'lead.add.draft.col.qty': 'मात्रा',
  'inventory.field.subProduct': 'उप-उत्पाद',
  'inventory.field.subProductPlaceholder': 'उप-उत्पाद चुनें…',
  'inventory.field.colour': 'रंग',
  'inventory.filter.product': 'उत्पाद फ़िल्टर',
  'inventory.filter.allProducts': 'सभी उत्पाद',

  // --- Carried over from the v1.1.0 line (sub-pages, free-to-sell) ---
  'nav.fold': 'उप-पृष्ठ छिपाएँ',
  'nav.home': 'डैशबोर्ड पर जाएँ',

  // --- Parity with en.ts after the 2026-09-19 merge ---
  'dashboard.activity.convertedOrder': "Order {orderId} created from {leadId}",
  'dashboard.activity.emptyDescription': "Moves, conversions and dispatches show up here.",
  'dashboard.activity.emptyTitle': "No activity yet",
  'dashboard.activity.leadSavedOffline': "Lead saved offline on Panel {device}",
  'dashboard.activity.orderReady': "Order {orderId} marked {stage}",
  'dashboard.activity.title': "Recent activity",
  'dashboard.activity.today': "Today {time}",
  'dashboard.activity.yesterday': "Yesterday {time}",
  'dashboard.followUp.emptyDescription': "Leads whose follow-up date arrives show up here.",
  'dashboard.followUp.emptyTitle': "Nothing due",
  'dashboard.followUp.title': "Follow up today",
  'dashboard.pipeline.emptyDescription': "Leads you create appear here, online or off.",
  'dashboard.pipeline.emptyTitle': "No open leads",
  'dashboard.pipeline.openBoard': "Open board",
  // TODO(i18n-hi)
  'updates.standaloneBody': "This is the standalone build, which cannot install an update over itself. Get the new standalone file, close this window, and replace the old file with it. The database and every setting stay exactly where they are.",
  'common.confirm': 'पुष्टि करें',
  'nav.master.parties': 'पार्टियाँ',
  'parties.created': '{name} सहेजा गया',
  'parties.updated': '{name} अपडेट किया गया',
  'parties.deleted': '{name} हटाया गया',
  'parties.deleteFailed': 'पार्टी हटाई नहीं जा सकी',
  'parties.deleteBlocked': '{items} में अब भी उपयोग में है — पहले उन्हें निपटाएँ',
  'parties.delete.title': '{name} को हटाएँ?',
  'parties.delete.body': 'यह रीसायकल बिन में जाता है और वापस लाया जा सकता है।',
  'parties.delete.confirm': 'पार्टी हटाएँ',
  'parties.error.load': 'पार्टियाँ लोड नहीं हो सकीं',
  'parties.loadMore': 'और लोड करें',
  'parties.summary': '{total} में से {shown} दिख रहे हैं',
  'leadsOrders.delete.lead': 'लीड हटाएँ',
  'leadsOrders.delete.order': 'ऑर्डर हटाएँ',
  'leadsOrders.delete.lead.title': 'लीड {id} हटाएँ?',
  'leadsOrders.delete.order.title': 'ऑर्डर {id} हटाएँ?',
  'leadsOrders.delete.body': 'यह रीसायकल बिन में जाता है और वापस लाया जा सकता है।',
  'leadsOrders.delete.failed': 'वह रिकॉर्ड हटाया नहीं जा सका',
  'leadsOrders.delete.blocked': '{items} में अब भी उपयोग में है — पहले उन्हें निपटाएँ',
  'signIn.notice.sessionEnded': 'आपका सत्र समाप्त हो गया। फिर से साइन इन करें।',
  'signIn.notice.passwordChanged': 'आपका पासवर्ड बदल गया। नए पासवर्ड से साइन इन करें।',
  'access.changePassword.title': 'अपना पासवर्ड बदलें',
  'access.changePassword.current': 'वर्तमान पासवर्ड',
  'access.changePassword.new': 'नया पासवर्ड',
  'access.changePassword.confirm': 'नया पासवर्ड दोबारा लिखें',
  'access.changePassword.mismatch': 'दोनों नए पासवर्ड मेल नहीं खाते',
  'access.changePassword.submit': 'पासवर्ड बदलें',
  'access.changePassword.failed': 'पासवर्ड बदला नहीं जा सका',
  'access.changePassword.signsYouOut': 'इसे बदलने पर आप हर जगह से साइन आउट हो जाएँगे, इस विंडो सहित।',
  'action.changePassword': 'पासवर्ड बदलें',
  'sync.changesRefused.one': '{count} बदलाव अस्वीकार किया गया',
  'sync.changesRefused.other': '{count} बदलाव अस्वीकार किए गए',
  'sync.couldNotSync': 'मास्टर के साथ सिंक नहीं हो सका',
  'sync.rejections.title': 'मास्टर ने अस्वीकार किया',
  'sync.rejections.description': 'ये इस पैनल पर सहेजे गए थे और मास्टर ने इन्हें नहीं लिया। ये दुकान के रिकॉर्ड में नहीं हैं।',
  'sync.rejections.dismiss': 'हटाएँ',
  'sync.rejections.dismissFailed': 'इन्हें हटाया नहीं जा सका',
  'sync.rejections.noReason': 'कोई कारण नहीं बताया गया',
  'action.reviewRefusals': 'देखें क्या अस्वीकार हुआ',
  'error.unauthorized.signInFailedRemaining.one': 'साइन-इन विफल — {count} प्रयास बचा है',
  'error.unauthorized.signInFailedRemaining.other': 'साइन-इन विफल — {count} प्रयास बचे हैं',
  'signin.credentialsRequired': 'अपना उपयोगकर्ता नाम और पासवर्ड दर्ज करें',
  'signin.forgetAction': 'इस पैनल से हटाएँ',
  'lead.add.discard': 'ड्राफ़्ट हटाएँ',
  'table.sortBy': '{column} से क्रमबद्ध करें',
  'table.redacted': 'छिपा हुआ',
  'settings.appearance.resetAll': 'दिखावट रीसेट करें',
  'partyAccess.showing': 'अब तक {shown} दिख रहे हैं।',
  'settingGroup.access': 'कौन अंदर आ सकता है',
  'settingGroup.stock': 'स्टॉक',
  'settingGroup.leads': 'लीड और फ़ॉलो-अप',
  'settingGroup.integrations': 'अन्य सॉफ़्टवेयर',
  'setting.unit.hours': 'घंटे',
  'setting.unit.days': 'दिन',
  'setting.unit.boxes': 'बॉक्स',
  'setting.number.none': 'कोई नहीं',
  'setting.panels.autoPairingEnabled.label': 'नए ऑफ़िस पैनल को बिना पासवर्ड जुड़ने दें',
  'setting.panels.autoPairingEnabled.help': 'जब तक ऑफ़िस पैनल जोड़ें खुला है, इस WiFi का कोई भी PC एक क्लिक में जुड़ सकता है। पैनल सेट हो जाने पर इसे बंद कर दें — फिर जुड़ने के लिए पेयरिंग पासवर्ड हमेशा ज़रूरी होगा।',
  'setting.security.developerModeEnabled.label': 'इस PC पर डेवलपर मोड की अनुमति दें',
  'setting.security.developerModeEnabled.help': 'डेवलपर मोड सारा डेटा मिटा सकता है और टेस्ट उपयोगकर्ता बना सकता है, और इसका पासवर्ड OrderBook की हर कॉपी में एक ही है। इसे बंद करने पर ऐप के अंदर का अनइंस्टॉलर भी बंद हो जाता है — OrderBook को Windows Settings → Apps से तब भी हटाया जा सकता है।',
  'setting.security.sessionHours.label': 'इतने समय बाद साइन आउट करें',
  'setting.security.sessionHours.help': 'कोई व्यक्ति दोबारा पासवर्ड डाले बिना कितनी देर साइन इन रहेगा। जो पहले से साइन इन हैं उनका समय वही रहेगा; यह उनके अगले साइन-इन से लागू होगा।',
  'setting.inventory.defaultReorderLevel.label': 'इससे कम होने पर स्टॉक कम',
  'setting.inventory.defaultReorderLevel.help': 'उन रंगों के लिए जिनका अपना कोई स्तर तय नहीं है। कोई नहीं चाहिए तो खाली छोड़ें। जिन रंगों का स्टॉक बिल्कुल नहीं है वे भी कम गिने जाएँगे।',
  'setting.security.offlineSignInEnabled.label': 'मास्टर पैनल बंद होने पर भी साइन इन करने दें',
  'setting.security.offlineSignInEnabled.help':
    'चालू रहने पर जो व्यक्ति पहले इस पैनल पर साइन इन कर चुका है वह मास्टर पैनल बंद होने पर भी दोबारा साइन इन कर सकता है, और उसे वही अनुमतियाँ मिलती हैं जो इस पैनल ने आख़िरी बार सहेजी थीं। बंद रहने पर हर साइन इन के लिए मास्टर चाहिए। जो पैनल पहले से ऑफ़लाइन है वह दोबारा जुड़ने तक अपना पिछला उत्तर ही रखता है।',
  'setting.inventory.adjustmentNoteRequired.label': 'स्टॉक गिनती सुधारते समय कारण अनिवार्य करें',
  'setting.inventory.adjustmentNoteRequired.help':
    'सुधार उस आँकड़े को बदल देता है जिसे दोबारा निकाला नहीं जा सकता। यह चालू होने पर सुधार करने वाले को कारण लिखना होगा। जो गिनती पहले से मेल खाती है उसकी पुष्टि करने पर कुछ दर्ज नहीं होता, इसलिए उसके लिए कारण नहीं चाहिए।',
  'setting.leads.followUpDefaultDays.label': 'नई लीड पर इतने दिन बाद संपर्क करें',
  'setting.leads.followUpDefaultDays.help':
    'नई लीड आज से इतने दिन बाद की फ़ॉलो-अप तारीख़ के साथ शुरू होती है। जब तक आप इसे न बदलें यह 3 है; 0 का अर्थ है आज। पूछताछ लेने वाला इसे बदल सकता है, और कल / 3 दिन में / अगले हफ़्ते वाले बटन पहले जैसे ही रहते हैं।',
  'setting.leads.packagingRequiredOnConvert.label': 'लीड को ऑर्डर बनाने से पहले पैकेजिंग अनिवार्य है',
  'setting.leads.packagingRequiredOnConvert.help':
    'डिफ़ॉल्ट रूप से बंद: लीड दर्ज करते समय पैकेजिंग नहीं पूछी जाती, और जिस लीड की पंक्तियों में पैकेजिंग नहीं है वह भी ऑर्डर बन सकती है। चालू होने पर लीड दर्ज करते समय हर पंक्ति के लिए पैकेजिंग पूछी जाती है और उसके बिना लीड को ऑर्डर नहीं बनाया जा सकता। पहले से भरी हुई पैकेजिंग दोनों स्थितियों में सुरक्षित रहती है।',
  'setting.leads.quietAfterDays.label': 'लीड इतने दिन बाद शांत मानी जाएगी',
  'setting.leads.quietAfterDays.help': 'लीड आउटकम रिपोर्ट किसी लीड को कितने दिन तक बिना छेड़े खुला गिनती रहे।',
  'error.unauthorized.developerDisabled': 'इस PC के लिए डेवलपर मोड बंद है। एक प्रशासक इसे सेटिंग्स → कौन अंदर आ सकता है में चालू कर सकता है।',
};
