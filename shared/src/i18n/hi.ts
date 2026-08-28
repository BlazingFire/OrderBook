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
  'permission.field.saleRate.view': 'बिक्री दर देखें',
  'permission.field.purchaseRate.view': 'खरीद दर देखें',
  'permission.field.purchaseRate.edit': 'खरीद दर संपादित करें',
  'permission.field.saleRate.edit': 'बिक्री दर संपादित करें',
  'permission.stock.adjust': 'भौतिक गणना से स्टॉक समायोजित करें',
  'permission.users.manage': 'उपयोगकर्ता प्रबंधित करें',
  'permission.users.viewPassword': 'संग्रहीत पासवर्ड दिखाएँ',
  'permission.roles.assign': 'उपयोगकर्ताओं को भूमिकाएँ सौंपें',
  'permission.panels.manage': 'ऑफ़िस पैनल प्रबंधित करें',
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
  'permission.documents.view': 'दस्तावेज़ देखें',
  'permission.documents.create': 'दस्तावेज़ बनाएँ',
  'permission.documents.edit': 'दस्तावेज़ संपादित करें',
  'permission.documents.delete': 'दस्तावेज़ हटाएँ',
  'permission.logs.verifyChain': 'ऑडिट श्रृंखला सत्यापित करें',
  'permission.recycleBin.view': 'रीसायकल बिन देखें',
  'permission.recycleBin.viewAll': 'सबके द्वारा हटाई गई वस्तुएँ देखें',
  'permission.fields.view': 'पाइपलाइन, चरण और कस्टम फ़ील्ड देखें',
  'permission.documents.render': 'दस्तावेज़ बनाएँ (रेंडर करें)',
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
  'module.documents': 'दस्तावेज़',

  'fieldSet.lead.sourcePlatform': 'लीड स्रोत',
  'fieldSet.stock.colour': 'रंग',
  'fieldSet.product.productType': 'उत्पाद प्रकार',
  'fieldSet.product.brand': 'ब्रांड',
  'fieldSet.product.shade': 'शेड',
  'fieldSet.product.surfaceTexture': 'सतह बनावट',
  'fieldSet.product.originPlant': 'उत्पादन संयंत्र',
  'fieldSet.line.packaging': 'पैकेजिंग',

  'action.view': 'देखें',
  'action.create': 'बनाएँ',
  'action.edit': 'संपादित करें',
  'action.delete': 'हटाएँ',
  'action.export': 'निर्यात करें',
  'action.bulk': 'थोक',

  'capabilityGroup.workflow': 'कार्यप्रवाह',
  'capabilityGroup.pricing': 'मूल्य निर्धारण',
  'capabilityGroup.stock': 'स्टॉक',
  'capabilityGroup.admin': 'प्रशासन',

  'roleTemplate.sales': 'बिक्री',
  'roleTemplate.dispatch': 'डिस्पैच',

  'setting.security.passwordRevealEnabled.label': 'पासवर्ड याद रखें ताकि उन्हें फिर दिखाया जा सके',
  'setting.security.passwordRevealEnabled.help':
    'जब तक यह चालू है, इस नेटवर्क पर टाइप किया गया हर पासवर्ड ऐसे रूप में रखा जाता है जिसे प्रशासक पढ़ सकता है। इसे बंद करने पर पहले से रखे गए सभी पासवर्ड हटा दिए जाते हैं।',
  'setting.ai.provider.label': 'एआई प्रदाता',
  'setting.ai.provider.help': 'एआई अनुभाग किस मॉडल से बात करता है। बंद का अर्थ है किसी से नहीं।',
  'setting.ai.apiKey.label': 'एआई कुंजी',
  'setting.ai.apiKey.help': 'सील करके रखी जाती है। सहेजने के बाद इसे दोबारा नहीं दिखाया जाता।',
  'setting.externalApi.enabled.label': 'अन्य सॉफ़्टवेयर को जुड़ने दें',
  'setting.externalApi.enabled.help':
    'नेटवर्क के अन्य प्रोग्रामों से कुंजी-युक्त अनुरोधों के लिए इस मास्टर को खोलता है।',
  'setting.externalApi.connectors.label': 'बाहर जाने वाले कनेक्शन',
  'setting.externalApi.connectors.help': 'वे अन्य सिस्टम जिन्हें यह मास्टर डेटा भेजता है।',

  'error.notFound': '{what} नहीं मिला',
  'error.forbidden.missingPermission': 'अनुमति नहीं है: {permission}',
  'error.forbidden.passwordRevealDisabled':
    'इस कंपनी के लिए पासवर्ड पुनर्प्राप्ति बंद है। कोई प्रशासक इसे सेटिंग्स में चालू कर सकता है।',
  'error.unauthorized': 'साइन इन नहीं है',
  'error.unauthorized.signInFailed': 'साइन-इन विफल',
  'error.unauthorized.accountDeactivated': 'यह खाता निष्क्रिय कर दिया गया है',
  'error.unauthorized.noRole': 'इस खाते की कोई भूमिका नहीं है। किसी प्रशासक से भूमिका देने को कहें।',
  'error.unauthorized.currentPasswordIncorrect': 'आपका मौजूदा पासवर्ड सही नहीं है',
  'error.unauthorized.tooManyAttempts': 'बहुत अधिक विफल प्रयास। एक मिनट में फिर कोशिश करें।',
  'error.unauthorized.pairingNotAccepting':
    'मास्टर पैनल अभी नए पैनल स्वीकार नहीं कर रहा है। मास्टर पर "ऑफ़िस पैनल जोड़ें" खोलकर फिर कोशिश करें।',
  'error.unauthorized.incorrectPairingPassword': 'जोड़ी पासवर्ड गलत है',
  'error.unauthorized.differentMaster': 'यह उस मास्टर पैनल से अलग है जिसे आपने दर्ज किया था',
  'error.unauthorized.panelNotPaired': 'यह पैनल जोड़ा नहीं गया है',
  'error.unauthorized.panelCredentialsInvalid': 'पैनल क्रेडेंशियल मान्य नहीं हैं',
  'error.forbidden.partyNotAssigned': 'वह पार्टी आपको नहीं सौंपी गई है',
  'error.forbidden.partyViewOnly': 'आप वह पार्टी देख सकते हैं, पर उसके रिकॉर्ड बदल नहीं सकते',
  'error.tenantViolation': '{what} इस कंपनी से संबंधित नहीं है',
  'error.conflict.alreadySetUp': 'यह मास्टर पैनल पहले ही सेटअप किया जा चुका है',
  'error.conflict.notSetUp': 'यह मास्टर पैनल अभी तक सेटअप नहीं किया गया है',
  'error.conflict.productCodeTaken': 'उत्पाद कोड "{productCode}" पहले से उपयोग में है',
  'error.conflict.nameTaken.role': '"{value}" नाम की भूमिका पहले से मौजूद है',
  'error.conflict.nameTaken.username': 'उपयोगकर्ता नाम "{value}" पहले से लिया जा चुका है',
  'error.conflict.staleVersion': 'किसी और ने इसे पहले ही सहेज लिया। बदलाव देखने के लिए फिर लोड करें।',
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
  'validation.stock.reorderLevelNegative': 'पुनःऑर्डर स्तर ऋणात्मक नहीं हो सकता',
  'validation.stock.colourRequired': 'यह स्टॉक किस रंग के लिए है यह चुनें',
  'validation.stock.productRequired': 'एक उत्पाद चुनें',
  'validation.stock.colourSelectRequired': 'एक रंग चुनें',
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
  'validation.product.uom': 'वह इकाई चुनें जिसमें यह उत्पाद गिना जाता है',
  'validation.product.edgeType': 'यह किनारे का प्रकार नहीं है',
  'validation.product.application': 'यह टाइल इस जगह के लिए मान्य नहीं है',
  'validation.product.peiRating': 'PEI रेटिंग 0 से 5 तक होती है',
  'validation.product.percentage': 'शून्य से सौ के बीच प्रतिशत भरें',
  'validation.product.negativeAmount': 'यह राशि ऋणात्मक नहीं हो सकती',
  'validation.stock.levelRange': 'अधिकतम, न्यूनतम से कम नहीं हो सकता',
  'validation.stock.levelNegative': 'स्टॉक स्तर ऋणात्मक नहीं हो सकता',
  'validation.pick.unknownKind': 'यह ऐसी चीज़ नहीं है जिसे यह पैनल खोज सके',
  'validation.product.nameRequired': 'उत्पाद का नाम आवश्यक है',
  'validation.product.codeRequired': 'उत्पाद कोड आवश्यक है',
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
  'validation.stage.leadConverted': 'यह लीड पहले ही ऑर्डर बन चुकी है — इसके बजाय ऑर्डर को स्थानांतरित करें',
  'validation.stage.archived': 'वह चरण संग्रहीत है और नए रिकॉर्ड स्वीकार नहीं कर सकता',
  'validation.stage.required': 'एक चरण चुनें',
  'validation.signIn.credentialsRequired': 'अपना आईडी और पासवर्ड दर्ज करें',
  'validation.pairing.invalidRequest': 'जोड़ी अनुरोध मान्य नहीं है',
  'validation.permissions.aboveTier.title': 'स्तर से ऊपर',
  'validation.cursor.malformed': 'परिणामों के इस पृष्ठ का लिंक अब मान्य नहीं है',
  'error.conflict.parentDeleted': 'एक या अधिक संबंधित रिकॉर्ड अभी भी रीसायकल बिन में हैं',
  'error.conflict.restoreCollision': 'एक मौजूदा रिकॉर्ड पहले से ही इस {field} का उपयोग कर रहा है',
  'error.conflict.passwordNotStored':
    'इस व्यक्ति के लिए अभी कोई पासवर्ड संग्रहीत नहीं है। अगली बार जब वे इस नेटवर्क पर साइन इन करेंगे तब वह याद रखा जाएगा।',
  'error.conflict.vaultUnreadable':
    'संग्रहीत पासवर्ड इस मशीन पर पढ़ा नहीं जा सका। इसके बजाय पासवर्ड रीसेट करें।',
  'error.conflict.blockedByLiveReferences': 'अन्य रिकॉर्ड अभी भी इसका संदर्भ देते हैं, पहले उन्हें निपटाएँ',
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

  'validation.documents.name.required': 'टेम्पलेट का नाम आवश्यक है',
  'validation.documents.documentType.unknown': 'यह दस्तावेज़ इस उत्पाद द्वारा नहीं बनाया जाता',
  'validation.documents.paperSize.unknown': 'इस उत्पाद द्वारा समर्थित कागज़ का आकार चुनें',
  'validation.documents.orientation.unknown': 'पोर्ट्रेट या लैंडस्केप चुनें',
  'validation.documents.margins.invalid': 'मार्जिन {min}mm और {max}mm के बीच होने चाहिए',
  'validation.documents.margins.exceedsPage': 'उन मार्जिन से दस्तावेज़ के लिए जगह नहीं बचती',
  'validation.documents.accentColour.invalid': 'रंग #RRGGBB के रूप में दर्ज करें',
  'validation.documents.watermarkText.required': 'वॉटरमार्क का पाठ दर्ज करें, या वॉटरमार्क बंद करें',
  'validation.documents.locale.unknown': 'यह भाषा इस उत्पाद में उपलब्ध नहीं है',
  'validation.documents.layout.duplicateKind': 'एक दस्तावेज़ में दो {kind} अनुभाग नहीं हो सकते',
  'validation.documents.layout.missingLines': 'दस्तावेज़ में वस्तु-सूची अनुभाग आवश्यक है',
  'validation.documents.layout.headerNotFirst': 'शीर्षलेख सबसे पहले आना चाहिए',
  'validation.documents.layout.signatureNotLast': 'हस्ताक्षर सबसे अंत में आना चाहिए',
  'validation.documents.layout.termsTooLong': 'शर्तें {max} अक्षरों से लंबी नहीं हो सकतीं',
  'validation.documents.layout.blockKindUnknown': 'यह अनुभाग दस्तावेज़ में नहीं हो सकता',
  'validation.documents.subjectKind.unknown': 'दस्तावेज़ किसी लीड या ऑर्डर के लिए बनाया जाता है',
  'validation.documents.templateType.mismatch':
    'वह टेम्पलेट {documentType} बनाता है, जो इस रिकॉर्ड पर लागू नहीं होता',
  'validation.documents.asset.unsupportedType': 'PNG या JPEG अपलोड करें',
  'validation.documents.asset.tooLarge': 'वह इमेज {maxBytes} बाइट से बड़ी है',
  'validation.documents.asset.kindUnknown': 'यह इमेज दस्तावेज़ में उपयोग नहीं होती',
  'validation.documents.asset.malformed': 'वह इमेज पढ़ी नहीं जा सकी',
  'error.conflict.nameTaken.documentTemplate': '"{value}" नाम का टेम्पलेट पहले से मौजूद है',
  'error.conflict.subjectDeleted': 'वह रिकॉर्ड रीसायकल बिन में है — पहले उसे पुनर्स्थापित करें',
  'error.documents.renderFailed': 'दस्तावेज़ नहीं बनाया जा सका',
  'error.documents.fontMissing': 'इस इंस्टॉलेशन में एक दस्तावेज़ फ़ॉन्ट नहीं मिला: {file}',

  'validation.image.fileRequired': 'एक इमेज फ़ाइल चुनें',
  'validation.image.tooLarge': 'वह फ़ाइल बहुत बड़ी है',
  'validation.image.unreadable': 'वह फ़ाइल इमेज के रूप में नहीं पढ़ी जा सकी — {reason}',
  'validation.image.crop.invalid': 'क्रॉप सही तरीके से लागू नहीं हुआ — फिर से प्रयास करें',
  'validation.image.crop.tooSmall': 'क्रॉप क्षेत्र बहुत छोटा है',
  'validation.image.crop.outOfBounds': 'क्रॉप क्षेत्र इमेज के बाहर है',
  'validation.image.rotation.invalid': 'रोटेशन सही तरीके से लागू नहीं हुआ — फिर से प्रयास करें',
  'validation.image.reorder.notPermutation': 'यह इस उत्पाद की इमेज का पूरा पुनर्क्रम नहीं है',
  'error.notFound.image': 'इमेज नहीं मिली',

  'validation.fields.listKeyRequired': 'चुनें कि यह कौन-सी सूची है',
  'validation.fields.entityInvalid': 'एक मान्य रिकॉर्ड प्रकार चुनें',
  'validation.fields.valueRequired': 'एक मान दर्ज करें',
  'validation.fields.valueImmutable': 'बनने के बाद मान नहीं बदला जा सकता — इसके बजाय लेबल बदलें',
  'validation.fields.hexInvalid': 'रंग को #RRGGBB के रूप में दर्ज करें',
  'validation.fields.reorderMismatch': 'यह पूरी, मौजूदा सूची नहीं है — पुनः लोड करके फिर कोशिश करें',
  'validation.fields.fieldTypeInvalid': 'एक मान्य फ़ील्ड प्रकार चुनें',
  'validation.fields.keyRequired': 'एक की (key) दर्ज करें',
  'validation.fields.keyImmutable': 'बनने के बाद की (key) नहीं बदली जा सकती',
  'validation.fields.optionsRequired': 'सेलेक्ट फ़ील्ड में कम से कम एक विकल्प होना चाहिए',
  'error.conflict.optionValueTaken': '"{value}" इस सूची में पहले से मौजूद है',
  'error.conflict.definitionKeyTaken': '"{key}" की के साथ एक कस्टम फ़ील्ड पहले से मौजूद है',
  'error.conflict.stageOccupied': 'इस चरण में अभी भी सक्रिय रिकॉर्ड हैं — पहले उन्हें ले जाएँ',
  'error.conflict.stageIsDefault': 'यह पाइपलाइन का डिफ़ॉल्ट चरण है और इसे संग्रहीत नहीं किया जा सकता',

  'activity.stock.inbound': '{actor} ने {product} के लिए {quantity} बॉक्स दर्ज किए',
  'activity.stock.adjusted': '{actor} ने {product} की गिनी गई स्टॉक समायोजित की',
  'activity.user.created': '{actor} ने {name} के लिए खाता बनाया',
  'activity.user.updated': '{actor} ने {name} को अपडेट किया',
  'activity.user.deactivated': '{actor} ने {name} को निष्क्रिय किया',
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
  'activity.office_panel.created': '{actor} ने ऑफ़िस पैनल {name} जोड़ा',
  'activity.office_panel.updated': '{actor} ने ऑफ़िस पैनल {name} को अपडेट किया',
  'activity.lead.created': '{actor} ने यह लीड बनाई',
  'activity.lead.updated': '{actor} ने यह लीड अपडेट की',
  'activity.lead.stage_changed': '{actor} ने इस लीड को {to} में ले जाया',
  'activity.lead.deleted': '{actor} ने यह लीड हटाई',
  'activity.lead.restored': '{actor} ने यह लीड पुनर्स्थापित की',
  'activity.order.updated': '{actor} ने यह ऑर्डर अपडेट किया',
  'activity.order.deleted': '{actor} ने यह ऑर्डर हटाया',
  'activity.order.restored': '{actor} ने यह ऑर्डर पुनर्स्थापित किया',
  'activity.party.deleted': '{actor} ने पार्टी {name} हटाई',
  'activity.party.restored': '{actor} ने पार्टी {name} पुनर्स्थापित की',
  'activity.party.access_changed': '{actor} ने बदला कि पार्टी {name} तक किसकी पहुँच है',
  'activity.product.deleted': '{actor} ने उत्पाद {name} हटाया',
  'activity.product.restored': '{actor} ने उत्पाद {name} पुनर्स्थापित किया',
  'activity.option_list_item.created': '{actor} ने विकल्प {name} जोड़ा',
  'activity.option_list_item.updated': '{actor} ने विकल्प {name} को अपडेट किया',
  'activity.option_list_item.deleted': '{actor} ने विकल्प {name} हटाया',
  'activity.option_list_item.restored': '{actor} ने विकल्प {name} पुनर्स्थापित किया',
  'activity.option_list_item.reordered': '{actor} ने {list} को पुनः क्रमित किया',
  'activity.custom_field_definition.created': '{actor} ने कस्टम फ़ील्ड {name} जोड़ी',
  'activity.custom_field_definition.updated': '{actor} ने कस्टम फ़ील्ड {name} को अपडेट किया',
  'activity.custom_field_definition.deleted': '{actor} ने कस्टम फ़ील्ड {name} हटाई',
  'activity.custom_field_definition.restored': '{actor} ने कस्टम फ़ील्ड {name} पुनर्स्थापित की',
  'activity.custom_field_definition.reordered': '{actor} ने {entity} के कस्टम फ़ील्ड पुनः क्रमित किए',
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

  'picker.searching': 'खोजा जा रहा है…',
  'picker.truncated': 'और मिलान हैं — इसे सीमित करने के लिए टाइप करते रहें',
  'picker.offline': 'ऑफ़लाइन — यह पैनल जो सहेजे है वही दिखा रहा है',
  'picker.empty': 'कुछ भी मेल नहीं खाता',
  'picker.create': 'नया जोड़ने के लिए Ctrl+Enter',
  'common.save': 'सहेजें',
  'common.cancel': 'रद्द करें',
  'common.delete': 'हटाएँ',
  'common.search': 'खोजें',
  'common.restore': 'पुनर्स्थापित करें',
  'common.export': 'निर्यात करें',
  'common.older': 'पुराने',
  'common.newer': 'नए',

  'count.leads.one': '{count} लीड',
  'count.leads.other': '{count} लीड',
  'count.rows.one': '{count} पंक्ति',
  'count.rows.other': '{count} पंक्तियाँ',
  // TODO(i18n-hi)
  'validation.avatar.fileRequired': "Choose a picture",
  // TODO(i18n-hi)
  'validation.avatar.tooLarge': "A profile picture must be 5 MB or smaller",
  // TODO(i18n-hi)
  'validation.avatar.unreadable': "That file could not be read as a picture",
  // TODO(i18n-hi)
  'activity.user.avatar_set': "{actor} set a profile picture for {name}",
  // TODO(i18n-hi)
  'activity.user.avatar_cleared': "{actor} removed the profile picture for {name}",
  // TODO(i18n-hi)
  'access.editor.backToList': "Roles & users",
  // TODO(i18n-hi)
  'access.permissions.blocked': "Needs the {tier} tier. Change the tier above to enable it.",
  // TODO(i18n-hi)
  'access.permissions.clearAll': "Clear all",
  // TODO(i18n-hi)
  'access.permissions.module': "Module",
  // TODO(i18n-hi)
  'access.permissions.modules': "Modules",
  // TODO(i18n-hi)
  'access.permissions.notApplicable': "This module has no such action — it cannot exist.",
  // TODO(i18n-hi)
  'access.permissions.saleRateHint': "Without this the rate is never sent to the person’s machine — the column disappears rather than showing blank.",
  // TODO(i18n-hi)
  'access.permissions.selectAll': "Select all",
  // TODO(i18n-hi)
  'access.permissions.tally': "Held",
  // TODO(i18n-hi)
  'access.permissions.toggleColumn': "Turn {action} on or off for every module",
  // TODO(i18n-hi)
  'access.permissions.toggleRow': "Turn every action on or off for {module}",
  // TODO(i18n-hi)
  'access.recycleBin.empty': "Nothing has been deleted.",
  // TODO(i18n-hi)
  'access.recycleBin.hide': "Hide deleted roles and people",
  // TODO(i18n-hi)
  'access.recycleBin.loading': "Loading…",
  // TODO(i18n-hi)
  'access.recycleBin.restore': "Restore",
  // TODO(i18n-hi)
  'access.recycleBin.restoreRoleFailed': "Could not restore the role",
  // TODO(i18n-hi)
  'access.recycleBin.restoreUserFailed': "Could not restore the person",
  // TODO(i18n-hi)
  'access.recycleBin.roleMeta': "role · {tier}",
  // TODO(i18n-hi)
  'access.recycleBin.show': "Show deleted roles and people",
  // TODO(i18n-hi)
  'access.recycleBin.userMeta': "person · {username}",
  // TODO(i18n-hi)
  'access.roleEditor.cancel': "Cancel",
  // TODO(i18n-hi)
  'access.roleEditor.changeTier': "Change to {tier}",
  // TODO(i18n-hi)
  'access.roleEditor.diffNone': "none",
  // TODO(i18n-hi)
  'access.roleEditor.diffNotSet': "not set",
  // TODO(i18n-hi)
  'access.roleEditor.diffPermissionsCount': "{count} permission{plural}",
  // TODO(i18n-hi)
  'access.roleEditor.discardConfirm': "Discard your unsaved changes to this role?",
  // TODO(i18n-hi)
  'access.roleEditor.keepTier': "Keep {tier}",
  // TODO(i18n-hi)
  'access.roleEditor.nameLabel': "Name",
  // TODO(i18n-hi)
  'access.roleEditor.newRole': "New role",
  // TODO(i18n-hi)
  'access.roleEditor.overwriteMine': "Overwrite with mine",
  // TODO(i18n-hi)
  'access.roleEditor.pendingWarning': "Changing to {tier} will remove {count} permission{plural}:",
  // TODO(i18n-hi)
  'access.roleEditor.reloadTheirs': "Reload theirs",
  // TODO(i18n-hi)
  'access.roleEditor.save': "Save",
  // TODO(i18n-hi)
  'access.roleEditor.saveFailedDefault': "Could not save the role",
  // TODO(i18n-hi)
  'access.roleEditor.saving': "Saving…",
  // TODO(i18n-hi)
  'access.roleEditor.theirs': "theirs",
  // TODO(i18n-hi)
  'access.roleEditor.tierLabel': "Tier",
  // TODO(i18n-hi)
  'access.roleEditor.tierLocked': "A system role’s tier is locked",
  // TODO(i18n-hi)
  'access.roleEditor.yours': "yours",
  // TODO(i18n-hi)
  'access.roles.cancel': "Cancel",
  // TODO(i18n-hi)
  'access.roles.colPermissions': "Permissions",
  // TODO(i18n-hi)
  'access.roles.colRole': "Role",
  // TODO(i18n-hi)
  'access.roles.colTier': "Tier",
  // TODO(i18n-hi)
  'access.roles.colUsers': "Users",
  // TODO(i18n-hi)
  'access.roles.create': "Create role",
  // TODO(i18n-hi)
  'access.roles.delete': "Delete",
  // TODO(i18n-hi)
  'access.roles.deleteBlocked': "Still assigned to somebody — move them first",
  // TODO(i18n-hi)
  'access.roles.deleteConfirmBody': "It goes to the Recycle Bin and can be restored, and anybody who still holds it reattaches when it comes back.",
  // TODO(i18n-hi)
  'access.roles.deleteConfirmTitle': "Delete the \"{name}\" role?",
  // TODO(i18n-hi)
  'access.roles.deleteFailed': "Could not delete",
  // TODO(i18n-hi)
  'access.roles.detail.catalogueLoading': "Still loading the permission list",
  // TODO(i18n-hi)
  'access.roles.detail.created': "Created",
  // TODO(i18n-hi)
  'access.roles.detail.grants': "What this role grants",
  // TODO(i18n-hi)
  'access.roles.detail.grantsCount': "{held} of {total} permissions granted",
  // TODO(i18n-hi)
  'access.roles.detail.grantsNone': "Nothing yet — this role grants no permissions.",
  // TODO(i18n-hi)
  'access.roles.detail.grantsUnknown': "Not in the catalogue",
  // TODO(i18n-hi)
  'access.roles.detail.id': "Role ID",
  // TODO(i18n-hi)
  'access.roles.detail.metaCounts': "{permissions} permissions · {users} people",
  // TODO(i18n-hi)
  'access.roles.detail.no': "No",
  // TODO(i18n-hi)
  'access.roles.detail.summary': "Summary",
  // TODO(i18n-hi)
  'access.roles.detail.system': "System role",
  // TODO(i18n-hi)
  'access.roles.detail.updated': "Last changed",
  // TODO(i18n-hi)
  'access.roles.detail.version': "Record version",
  // TODO(i18n-hi)
  'access.roles.detail.yes': "Yes",
  // TODO(i18n-hi)
  'access.roles.edit': "Edit",
  // TODO(i18n-hi)
  'access.roles.empty': "No roles yet. The Administrator role was created with this company.",
  // TODO(i18n-hi)
  'access.roles.open': "Open",
  // TODO(i18n-hi)
  'access.roles.systemBadge': "system",
  // TODO(i18n-hi)
  'access.roles.title': "{count} roles",
  // TODO(i18n-hi)
  'access.roles.titleLoading': "Roles",
  // TODO(i18n-hi)
  'access.secret.copied': "Copied",
  // TODO(i18n-hi)
  'access.secret.copy': "Copy",
  // TODO(i18n-hi)
  'access.secret.done': "Done",
  // TODO(i18n-hi)
  'access.secret.helper': 'इसे अभी कॉपी करके सौंप दें। यह स्क्रीन इसे दोबारा नहीं दिखाएगी।',
  // TODO(i18n-hi)
  'access.secret.title': "Temporary password for {username}",
  // TODO(i18n-hi)
  'access.tab.roles': "Roles",
  // TODO(i18n-hi)
  'access.tab.users': "Users",
  // TODO(i18n-hi)
  'access.title': "Roles & Users",
  // TODO(i18n-hi)
  'access.userEdit.cancel': "Cancel",
  // TODO(i18n-hi)
  'access.userEdit.displayName': "Display name",
  // TODO(i18n-hi)
  'access.userEdit.save': "Save",
  // TODO(i18n-hi)
  'access.userEdit.saveFailed': "Could not save",
  // TODO(i18n-hi)
  'access.userEdit.username': "Username",
  // TODO(i18n-hi)
  'access.userForm.cancel': "Cancel",
  // TODO(i18n-hi)
  'access.userForm.create': "Create user",
  // TODO(i18n-hi)
  'access.userForm.createFailed': "Could not create the user",
  // TODO(i18n-hi)
  'access.userForm.displayName': "Display name",
  // TODO(i18n-hi)
  'access.userForm.helper': "A temporary password is generated and shown once. There is no way to see it again.",
  // TODO(i18n-hi)
  'access.userForm.role': "Role",
  // TODO(i18n-hi)
  'access.userForm.username': "Username",
  // TODO(i18n-hi)
  'access.users.activate': "Activate",
  // TODO(i18n-hi)
  'access.users.add': "Add user",
  // TODO(i18n-hi)
  'access.users.cancel': "Cancel",
  // TODO(i18n-hi)
  'access.users.colId': "ID",
  // TODO(i18n-hi)
  'access.users.colLastSignIn': "Last sign-in",
  // TODO(i18n-hi)
  'access.users.colName': "Name",
  // TODO(i18n-hi)
  'access.users.colRole': "Role",
  // TODO(i18n-hi)
  'access.users.colStatus': "Status",
  // TODO(i18n-hi)
  'access.users.colUsername': "Username",
  // TODO(i18n-hi)
  'access.users.deactivate': "Deactivate",
  // TODO(i18n-hi)
  'access.users.deactivateConfirmBody': "{name} will not be able to sign in. Their leads, orders and audit history are unchanged. This is not a delete — use Delete to send them to the Recycle Bin.",
  // TODO(i18n-hi)
  'access.users.deactivateConfirmTitle': "Deactivate {name}?",
  // TODO(i18n-hi)
  'access.users.delete': "Delete",
  // TODO(i18n-hi)
  'access.users.deleteConfirmBody': "They go to the Recycle Bin and can be restored. Their records and audit history stay exactly as they are.",
  // TODO(i18n-hi)
  'access.users.deleteConfirmTitle': "Delete {name}?",
  // TODO(i18n-hi)
  'access.users.deleteFailed': "Could not delete",
  // TODO(i18n-hi)
  'access.users.detail.access': "Access",
  // TODO(i18n-hi)
  'access.users.detail.activity': "Activity",
  // TODO(i18n-hi)
  'access.users.detail.created': "Added",
  // TODO(i18n-hi)
  'access.users.detail.identity': "Identity",
  // TODO(i18n-hi)
  'access.users.detail.updated': "Last changed",
  // TODO(i18n-hi)
  'access.users.detail.version': "Record version",
  // TODO(i18n-hi)
  'access.users.edit': "Edit",
  // TODO(i18n-hi)
  'access.users.empty': "Nobody here yet.",
  // TODO(i18n-hi)
  'access.users.emptyFiltered': "Nobody matches those filters.",
  // TODO(i18n-hi)
  'access.users.filterRoleAll': "All roles",
  // TODO(i18n-hi)
  'access.users.filterRoleLabel': "Filter by role",
  // TODO(i18n-hi)
  'access.users.filterStatusActive': "Active",
  // TODO(i18n-hi)
  'access.users.filterStatusInactive': "Inactive",
  // TODO(i18n-hi)
  'access.users.generateInstead': "Generate one instead",
  // TODO(i18n-hi)
  'access.users.lastAdminReason': "At least one active administrator must remain",
  // TODO(i18n-hi)
  'access.users.newPassword': "New password",
  // TODO(i18n-hi)
  'access.users.newPasswordHint': "At least 8 characters. Shown once here, then only its hash is kept.",
  // TODO(i18n-hi)
  'access.users.open': "Open",
  // TODO(i18n-hi)
  'access.users.resetPassword': "Reset password",
  'access.users.revealPassword': 'पासवर्ड दिखाएँ',
  'access.users.revealPasswordTitle': '{name} का पासवर्ड दिखाएँ',
  'access.users.revealPasswordSubtitle':
    'जारी रखने के लिए अपना पासवर्ड टाइप करें। इसका हर उपयोग गतिविधि लॉग में स्थायी रूप से दर्ज होता है।',
  'access.users.revealPasswordConfirm': 'आपका पासवर्ड',
  'access.users.revealPasswordConfirmHint': 'वही जिससे आपने साइन इन किया।',
  'access.users.revealPasswordFailed': 'वह पासवर्ड दिखाया नहीं जा सका',
  'access.users.reveal': 'दिखाएँ',
  // TODO(i18n-hi)
  'access.users.resetPasswordFailed': "Could not reset the password",
  // TODO(i18n-hi)
  'access.users.roleChangeFailed': "Could not change the role",
  // TODO(i18n-hi)
  'access.users.roleHint': "Saved as soon as you choose. Everything this person may do comes from their role.",
  // TODO(i18n-hi)
  'access.users.searchLabel': "Search people",
  // TODO(i18n-hi)
  'access.users.searchPlaceholder': "Search name or username…",
  // TODO(i18n-hi)
  'access.users.setPassword': "Set password",
  // TODO(i18n-hi)
  'access.users.setPasswordSubtitle': 'किसी को उनका पासवर्ड बताने का तरीका यही है कि आप एक ज्ञात पासवर्ड सेट करें। संग्रहीत हैश को कभी उलटा नहीं जाता।',
  // TODO(i18n-hi)
  'access.users.setPasswordTitle': "Set a password for {name}",
  // TODO(i18n-hi)
  'access.users.sortCreated': "Creation order",
  // TODO(i18n-hi)
  'access.users.sortLabel': "Sort by",
  // TODO(i18n-hi)
  'access.users.sortLastSignIn': "Last sign-in",
  // TODO(i18n-hi)
  'access.users.sortName': "Name",
  // TODO(i18n-hi)
  'access.users.sortRole': "Role",
  // TODO(i18n-hi)
  'access.users.statusActive': "Active",
  // TODO(i18n-hi)
  'access.users.statusChangeFailed': "Could not change the status",
  // TODO(i18n-hi)
  'access.users.statusInactive': "Inactive",
  // TODO(i18n-hi)
  'access.users.thisIsYou': "This is you",
  // TODO(i18n-hi)
  'access.users.title': "{count} people",
  // TODO(i18n-hi)
  'access.users.titleLoading': "People",
  // TODO(i18n-hi)
  'action.cancel': "Cancel",
  // TODO(i18n-hi)
  'action.close': "Close",
  // TODO(i18n-hi)
  'action.dismiss': "Dismiss",
  // TODO(i18n-hi)
  'action.done': "Done",
  // TODO(i18n-hi)
  'action.newLead': "New lead",
  // TODO(i18n-hi)
  'action.retryNow': "Retry now",
  // TODO(i18n-hi)
  'action.reviewConflicts': "Review conflicts",
  // TODO(i18n-hi)
  'action.signOut': "Sign out",
  // TODO(i18n-hi)
  'app.name': "OrderBook",
  // TODO(i18n-hi)
  'avatar.change': "Change picture",
  // TODO(i18n-hi)
  'avatar.choose': "Choose a picture",
  // TODO(i18n-hi)
  'avatar.error.notAnImage': "That file is not a picture.",
  // TODO(i18n-hi)
  'avatar.error.removeFailed': "Could not remove the picture",
  // TODO(i18n-hi)
  'avatar.error.tooLarge': "A profile picture must be 5 MB or smaller.",
  // TODO(i18n-hi)
  'avatar.error.uploadFailed': "Could not save the picture",
  // TODO(i18n-hi)
  'avatar.hint': "Squared and resized to {px} px on save. JPEG, PNG or WebP, up to {max}.",
  // TODO(i18n-hi)
  'avatar.remove': "Remove",
  // TODO(i18n-hi)
  'avatar.section': "Profile picture",
  // TODO(i18n-hi)
  'backup.export.action': "Export data…",
  // TODO(i18n-hi)
  'backup.export.confirm': "Export",
  // TODO(i18n-hi)
  'backup.export.done': "Export ready — check your downloads",
  // TODO(i18n-hi)
  'backup.export.passphraseHint': "At least 10 characters. This passphrase is never stored anywhere — if it is lost, this file cannot be opened again.",
  // TODO(i18n-hi)
  'backup.export.passphraseLabel': "Export passphrase",
  // TODO(i18n-hi)
  'backup.export.scopeFullReplica': "Full device replica",
  // TODO(i18n-hi)
  'backup.export.scopeLabel': "What to export",
  // TODO(i18n-hi)
  'backup.export.scopeSettingsOnly': "Local settings only",
  // TODO(i18n-hi)
  'backup.export.working': "Preparing export…",
  // TODO(i18n-hi)
  'backup.restore.action': "Restore from backup…",
  // TODO(i18n-hi)
  'backup.restore.cancel': "Cancel",
  // TODO(i18n-hi)
  'backup.restore.chooseFile': "Choose backup file…",
  // TODO(i18n-hi)
  'backup.restore.confirm': "Restore",
  // TODO(i18n-hi)
  'backup.restore.confirmWipeInput': "Type CONFIRM",
  // TODO(i18n-hi)
  'backup.restore.done': "Restore complete",
  // TODO(i18n-hi)
  'backup.restore.donePairAgain': "This device has been restored. It will now reload and ask you to pair again.",
  // TODO(i18n-hi)
  'backup.restore.newPairingPassword': "New pairing password (shown once): {password}. Every Office Panel must re-pair using it.",
  // TODO(i18n-hi)
  'backup.restore.passphraseLabel': "Backup passphrase",
  // TODO(i18n-hi)
  'backup.restore.previewAppVersion': "App version",
  // TODO(i18n-hi)
  'backup.restore.previewCreated': "Created",
  // TODO(i18n-hi)
  'backup.restore.previewScope': "Scope",
  // TODO(i18n-hi)
  'backup.restore.previewSource': "Source",
  // TODO(i18n-hi)
  'backup.restore.title': "Restore from backup",
  // TODO(i18n-hi)
  'backup.restore.working': "Restoring…",
  // TODO(i18n-hi)
  'catalog.filter.all': "All",
  // TODO(i18n-hi)
  'catalog.parties.column.access': "My access",
  // TODO(i18n-hi)
  'catalog.parties.column.city': "City",
  // TODO(i18n-hi)
  'catalog.parties.column.code': "Code",
  // TODO(i18n-hi)
  'catalog.parties.column.name': "Name",
  // TODO(i18n-hi)
  'catalog.parties.column.phone': "Phone",
  // TODO(i18n-hi)
  'catalog.parties.column.variants': "Products",
  // TODO(i18n-hi)
  'catalog.parties.created': "{name} saved — syncs when the Master is reachable",
  // TODO(i18n-hi)
  'catalog.parties.empty.description': "Parties you create appear here, online or off.",
  // TODO(i18n-hi)
  'catalog.parties.empty.filtered': "No parties match this search.",
  // TODO(i18n-hi)
  'catalog.parties.empty.title': "No parties yet",
  // TODO(i18n-hi)
  'catalog.parties.new': "New party",
  // TODO(i18n-hi)
  'catalog.parties.notSynced': "not synced",
  // TODO(i18n-hi)
  'catalog.parties.searchLabel': "Search parties",
  // TODO(i18n-hi)
  'catalog.parties.searchPlaceholder': "Search name, code, phone…",
  // TODO(i18n-hi)
  'catalog.products.column.code': "Code",
  // TODO(i18n-hi)
  'catalog.products.column.grade': "Grade",
  // TODO(i18n-hi)
  'catalog.products.column.name': "Product",
  // TODO(i18n-hi)
  'catalog.products.column.rate': "Rate / box",
  // TODO(i18n-hi)
  'catalog.products.column.size': "Size",
  // TODO(i18n-hi)
  'catalog.products.column.stock': "Free to sell, by colour",
  // TODO(i18n-hi)
  'catalog.products.column.type': "Type",
  // TODO(i18n-hi)
  'catalog.products.created': "{name} saved — syncs when the Master is reachable",
  // TODO(i18n-hi)
  'catalog.products.empty.description': "Products you create appear here, online or off.",
  // TODO(i18n-hi)
  'catalog.products.empty.filtered': "No products match this search.",
  // TODO(i18n-hi)
  'catalog.products.empty.title': "No products yet",
  // TODO(i18n-hi)
  'catalog.products.new': "New product",
  // TODO(i18n-hi)
  'catalog.products.searchLabel': "Search products",
  // TODO(i18n-hi)
  'catalog.products.searchPlaceholder': "Search code, name, alias…",
  // TODO(i18n-hi)
  'catalog.stock.free': "free",
  // TODO(i18n-hi)
  'catalog.stock.low': "low",
  // TODO(i18n-hi)
  'catalog.stock.none': "—",
  // TODO(i18n-hi)
  'catalog.stock.onFloor': "{onFloor} on floor",
  // TODO(i18n-hi)
  'catalog.stock.onFloorReserved': "{onFloor} on floor, {reserved} reserved",
  // TODO(i18n-hi)
  'catalog.stock.short': "Short {count}",
  // TODO(i18n-hi)
  'catalog.stock.tooltip': "{colour} — {onFloor} on floor",
  // TODO(i18n-hi)
  'catalog.stock.tooltipReserved': "{colour} — {onFloor} on floor, {reserved} reserved",
  // TODO(i18n-hi)
  'common.no': "No",
  // TODO(i18n-hi)
  'common.yes': "Yes",
  // TODO(i18n-hi)
  'conflicts.action.keepWinner': "Keep what is there",
  // TODO(i18n-hi)
  'conflicts.action.restoreLoser': "Put the other value back",
  // TODO(i18n-hi)
  'conflicts.description': "Raised when two panels edited the same field of the same record while both were offline. The higher timestamp won; the other value is kept here so nothing is lost silently.",
  // TODO(i18n-hi)
  'conflicts.empty.description': "Conflicts appear here when two panels edit the same field of the same record while both are offline.",
  // TODO(i18n-hi)
  'conflicts.empty.title': "No conflicts",
  // TODO(i18n-hi)
  'conflicts.empty.value': "(empty)",
  // TODO(i18n-hi)
  'conflicts.emptyValue': "(empty)",
  // TODO(i18n-hi)
  'conflicts.error.load': "Could not load conflicts",
  // TODO(i18n-hi)
  'conflicts.error.resolve': "Could not resolve the conflict",
  // TODO(i18n-hi)
  'conflicts.includeReviewed': "Include reviewed",
  // TODO(i18n-hi)
  'conflicts.kept': "Kept (device {device})",
  // TODO(i18n-hi)
  'conflicts.noPermission': "Your role does not include {permission}.",
  // TODO(i18n-hi)
  'conflicts.overwritten': "Overwritten (device {device})",
  // TODO(i18n-hi)
  'conflicts.resolveErrorFallback': "Could not resolve the conflict",
  // TODO(i18n-hi)
  'conflicts.reviewedAt': "Reviewed {when}",
  // TODO(i18n-hi)
  'connection.auto.connect': "Proceed with Auto Connection",
  // TODO(i18n-hi)
  'connection.auto.connecting': "Searching…",
  // TODO(i18n-hi)
  'connection.auto.scanOnly': "Search only",
  // TODO(i18n-hi)
  'connection.auto.step1': "On the Master Panel PC, open “Office Panels” and press “Add Office Panel”.",
  // TODO(i18n-hi)
  'connection.auto.step2': "It will say “Waiting for office panel…”.",
  // TODO(i18n-hi)
  'connection.auto.step3': "Press the button below. The two will find each other automatically.",
  // TODO(i18n-hi)
  'connection.auto.title': "Auto connection (recommended)",
  // TODO(i18n-hi)
  'connection.errorFallback': "Connection failed",
  // TODO(i18n-hi)
  'connection.manual.address': "Master address",
  // TODO(i18n-hi)
  'connection.manual.connect': "Connect",
  // TODO(i18n-hi)
  'connection.manual.connecting': "Connecting…",
  // TODO(i18n-hi)
  'connection.manual.hint': "Use the address and pairing password shown on the Master Panel’s setup screen.",
  // TODO(i18n-hi)
  'connection.manual.password': "Pairing password",
  // TODO(i18n-hi)
  'connection.manual.port': "Port",
  // TODO(i18n-hi)
  'connection.manual.title': "Manual connection",
  // TODO(i18n-hi)
  'connection.mode.auto': "Auto connection",
  // TODO(i18n-hi)
  'connection.mode.manual': "Manual connection",
  // TODO(i18n-hi)
  'connection.panelName': "Name for this PC",
  // TODO(i18n-hi)
  'connection.scan.acceptingNo': "Not right now",
  // TODO(i18n-hi)
  'connection.scan.acceptingYes': "Yes",
  // TODO(i18n-hi)
  'connection.scan.col.accepting': "Accepting",
  // TODO(i18n-hi)
  'connection.scan.col.address': "Address",
  // TODO(i18n-hi)
  'connection.scan.col.master': "Master",
  // TODO(i18n-hi)
  'connection.scan.defaultName': "Master Panel",
  // TODO(i18n-hi)
  'connection.scan.none.description': "Check that the Master PC is switched on and on the same network.",
  // TODO(i18n-hi)
  'connection.scan.none.title': "No Master Panel answered",
  // TODO(i18n-hi)
  'connection.scanErrorFallback': "Could not search the network",
  // TODO(i18n-hi)
  'connection.status.connected': "Connected to network",
  // TODO(i18n-hi)
  'connection.status.disconnected': "Not connected to any network",
  // TODO(i18n-hi)
  'connection.status.hint': "Plug in the LAN cable or join the shop WiFi, then this screen will update.",
  // TODO(i18n-hi)
  'connection.status.thisPc': "This PC: {addresses}",
  // TODO(i18n-hi)
  'connection.title': "Connect to Master Panel",
  // TODO(i18n-hi)
  'crash.body': "The panel stopped rather than showing something wrong. Reloading usually gets you back to where you were.",
  // TODO(i18n-hi)
  'crash.copy': "Copy details",
  // TODO(i18n-hi)
  'crash.reload': "Reload",
  // TODO(i18n-hi)
  'crash.title': "Something went wrong on this screen",
  // TODO(i18n-hi)
  'dashboard.dispatched.countOnly': "{count} {unit} dispatched",
  // TODO(i18n-hi)
  'dashboard.dispatched.none': "Nothing dispatched yet this week",
  // TODO(i18n-hi)
  'dashboard.dispatched.summary': "{amount} across {count} {unit}",
  // TODO(i18n-hi)
  'dashboard.dispatched.title': "Dispatched this week",
  // TODO(i18n-hi)
  'dashboard.dispatched.unitMany': "orders",
  // TODO(i18n-hi)
  'dashboard.dispatched.unitOne': "order",
  // TODO(i18n-hi)
  'dashboard.empty.description': "Once leads, orders or stock exist on this panel, your dashboard fills in.",
  // TODO(i18n-hi)
  'dashboard.empty.title': "Nothing here yet",
  // TODO(i18n-hi)
  'dashboard.leads.dueToday': "{count} due for follow-up today",
  // TODO(i18n-hi)
  'dashboard.leads.noneDueToday': "None due today",
  // TODO(i18n-hi)
  'dashboard.leads.title': "Open leads",
  // TODO(i18n-hi)
  'dashboard.orders.boxesReserved': "{count} boxes reserved",
  // TODO(i18n-hi)
  'dashboard.orders.noneReserved': "Nothing reserved",
  // TODO(i18n-hi)
  'dashboard.orders.title': "Open orders",
  // TODO(i18n-hi)
  'dashboard.panels.addressUnknown': "Unknown address",
  // TODO(i18n-hi)
  'dashboard.panels.deviceLabel': "device {code}",
  // TODO(i18n-hi)
  'dashboard.panels.empty.description': "Panels you add appear here, online or off.",
  // TODO(i18n-hi)
  'dashboard.panels.empty.title': "No office panels yet",
  // TODO(i18n-hi)
  'dashboard.panels.footerNote': "A panel that is offline is still taking leads — they arrive here when it reconnects.",
  // TODO(i18n-hi)
  'dashboard.panels.subtitle': "{connected} of {total} online",
  // TODO(i18n-hi)
  'dashboard.stat.conflicts': "Conflicts to review",
  // TODO(i18n-hi)
  'dashboard.stat.conflicts.noteNone': "Nothing to review",
  // TODO(i18n-hi)
  'dashboard.stat.conflicts.noteSome': "Waiting for review",
  // TODO(i18n-hi)
  'dashboard.stat.lowStock': "Low stock",
  // TODO(i18n-hi)
  'dashboard.stat.lowStock.noteNone': "All products healthy",
  // TODO(i18n-hi)
  'dashboard.stat.lowStock.noteSome': "Below reorder level",
  // TODO(i18n-hi)
  'dashboard.stat.panelsOnline': "Panels online",
  // TODO(i18n-hi)
  'dashboard.stat.panelsOnline.noteAll': "All panels connected",
  // TODO(i18n-hi)
  'dashboard.stat.panelsOnline.noteNone': "No panels registered yet",
  // TODO(i18n-hi)
  'dashboard.stat.panelsOnline.noteSome': "{count} unreachable",
  // TODO(i18n-hi)
  'dashboard.stat.pendingSync': "Pending sync",
  // TODO(i18n-hi)
  'dashboard.stat.pendingSync.note': "Changes waiting on panels",
  // TODO(i18n-hi)
  'dashboard.sync.allSynced': "All synced",
  // TODO(i18n-hi)
  'dashboard.sync.allSyncedNote': "Nothing queued on this machine",
  // TODO(i18n-hi)
  'dashboard.sync.conflictNote': "Fields resolved while offline — review to keep the right value",
  // TODO(i18n-hi)
  'dashboard.sync.pending': "{count} pending",
  // TODO(i18n-hi)
  'dashboard.sync.pendingNote': "Queued on this machine — syncs when reachable",
  // TODO(i18n-hi)
  'dashboard.sync.title': "Sync",
  // TODO(i18n-hi)
  'dashboard.sync.toReview': "{count} to review",
  // TODO(i18n-hi)
  'documents.cancel': "Cancel",
  // TODO(i18n-hi)
  'documents.editor.accentColour': "Accent colour",
  // TODO(i18n-hi)
  'documents.editor.accentHint': "Hex like #2F6FEB. Blank uses the app accent.",
  // TODO(i18n-hi)
  'documents.editor.default': "Default template",
  // TODO(i18n-hi)
  'documents.editor.defaultHint': "One default per document type.",
  // TODO(i18n-hi)
  'documents.editor.defaultLabel': "Use this one unless another is chosen",
  // TODO(i18n-hi)
  'documents.editor.documentType': "Document",
  // TODO(i18n-hi)
  'documents.editor.footerText': "Footer text",
  // TODO(i18n-hi)
  'documents.editor.group.branding': "Company marks",
  // TODO(i18n-hi)
  'documents.editor.group.content': "What the document says",
  // TODO(i18n-hi)
  'documents.editor.group.margins': "Margins (mm)",
  // TODO(i18n-hi)
  'documents.editor.group.pageFurniture': "Around the page",
  // TODO(i18n-hi)
  'documents.editor.margin.bottom': "Bottom",
  // TODO(i18n-hi)
  'documents.editor.margin.left': "Left",
  // TODO(i18n-hi)
  'documents.editor.margin.right': "Right",
  // TODO(i18n-hi)
  'documents.editor.margin.top': "Top",
  // TODO(i18n-hi)
  'documents.editor.name': "Name",
  // TODO(i18n-hi)
  'documents.editor.newTitle': "New template",
  // TODO(i18n-hi)
  'documents.editor.orientation': "Orientation",
  // TODO(i18n-hi)
  'documents.editor.overwriteMine': "Overwrite with mine",
  // TODO(i18n-hi)
  'documents.editor.paperSize': "Paper size",
  // TODO(i18n-hi)
  'documents.editor.reloadTheirs': "Reload theirs",
  // TODO(i18n-hi)
  'documents.editor.save': "Save",
  // TODO(i18n-hi)
  'documents.editor.saveFailed': "Could not save the template",
  // TODO(i18n-hi)
  'documents.editor.saved': "Saved “{name}”",
  // TODO(i18n-hi)
  'documents.editor.showColourChips': "Colour swatches beside each line",
  // TODO(i18n-hi)
  'documents.editor.showLogo': "Logo",
  // TODO(i18n-hi)
  'documents.editor.showPageNumbers': "Page numbers",
  // TODO(i18n-hi)
  'documents.editor.showPartyBlock': "Party name and address block",
  // TODO(i18n-hi)
  'documents.editor.showRates': "Rates and amounts",
  // TODO(i18n-hi)
  'documents.editor.showSignature': "Signature block",
  // TODO(i18n-hi)
  'documents.editor.showTerms': "Terms",
  // TODO(i18n-hi)
  'documents.editor.showWatermark': "Watermark",
  // TODO(i18n-hi)
  'documents.editor.termsHint': "Up to {max} characters.",
  // TODO(i18n-hi)
  'documents.editor.termsText': "Terms",
  // TODO(i18n-hi)
  'documents.editor.theirs': "theirs",
  // TODO(i18n-hi)
  'documents.editor.watermarkText': "Watermark text",
  // TODO(i18n-hi)
  'documents.editor.yours': "yours",
  // TODO(i18n-hi)
  'documents.exports.colDocument': "File",
  // TODO(i18n-hi)
  'documents.exports.colPages': "Pages",
  // TODO(i18n-hi)
  'documents.exports.colRates': "Rates",
  // TODO(i18n-hi)
  'documents.exports.colRenderedBy': "Rendered by",
  // TODO(i18n-hi)
  'documents.exports.colSize': "Size",
  // TODO(i18n-hi)
  'documents.exports.colSubject': "For",
  // TODO(i18n-hi)
  'documents.exports.colTemplate': "Template",
  // TODO(i18n-hi)
  'documents.exports.colType': "Document",
  // TODO(i18n-hi)
  'documents.exports.colWhen': "When",
  // TODO(i18n-hi)
  'documents.exports.description': "Every document that was rendered, kept as the record of what was sent. Exports are never deleted.",
  // TODO(i18n-hi)
  'documents.exports.download': "Download",
  // TODO(i18n-hi)
  'documents.exports.empty.description': "Documents rendered from a lead or an order appear here with the file that was sent.",
  // TODO(i18n-hi)
  'documents.exports.empty.title': "Nothing rendered yet",
  // TODO(i18n-hi)
  'documents.exports.loadFailed': "Could not load the export history",
  // TODO(i18n-hi)
  'documents.exports.renderedByPanel': "Office panel",
  // TODO(i18n-hi)
  'documents.exports.sectionTitle': "Export history",
  // TODO(i18n-hi)
  'documents.exports.withRates': "Included",
  // TODO(i18n-hi)
  'documents.exports.withoutRates': "Omitted",
  // TODO(i18n-hi)
  'documents.loadMore': "Load more",
  // TODO(i18n-hi)
  'documents.noAccess.description': "Your role does not include {permission}.",
  // TODO(i18n-hi)
  'documents.noAccess.title': "Documents are not open to you",
  // TODO(i18n-hi)
  'documents.orientation.landscape': "Landscape",
  // TODO(i18n-hi)
  'documents.orientation.portrait': "Portrait",
  // TODO(i18n-hi)
  'documents.preview.action': "Preview",
  // TODO(i18n-hi)
  'documents.preview.description': "Renders what is on this form, saved or not, against a real record — nothing is stored.",
  // TODO(i18n-hi)
  'documents.preview.failed': "Could not build the preview",
  // TODO(i18n-hi)
  'documents.preview.loadingSubjects': "Finding a record to preview against…",
  // TODO(i18n-hi)
  'documents.preview.noSubjects': "Nothing to preview this template against yet.",
  // TODO(i18n-hi)
  'documents.preview.popupBlocked': "Your browser blocked the preview tab. Allow pop-ups for OrderBook, then preview again.",
  // TODO(i18n-hi)
  'documents.preview.subject': "Preview against",
  // TODO(i18n-hi)
  'documents.preview.subjectsFailed': "Could not load anything to preview against",
  // TODO(i18n-hi)
  'documents.preview.title': "Preview",
  // TODO(i18n-hi)
  'documents.tab.exports': "Export history",
  // TODO(i18n-hi)
  'documents.tab.templates': "Templates",
  // TODO(i18n-hi)
  'documents.templates.colName': "Template",
  // TODO(i18n-hi)
  'documents.templates.colPaper': "Paper",
  // TODO(i18n-hi)
  'documents.templates.colRates': "Rates",
  // TODO(i18n-hi)
  'documents.templates.colType': "Document",
  // TODO(i18n-hi)
  'documents.templates.colUpdated': "Updated",
  // TODO(i18n-hi)
  'documents.templates.create': "New template",
  // TODO(i18n-hi)
  'documents.templates.defaultBadge': "default",
  // TODO(i18n-hi)
  'documents.templates.delete': "Delete",
  // TODO(i18n-hi)
  'documents.templates.deleteConfirmBody': "It goes to the Recycle Bin and can be restored. Documents already rendered from it are untouched — they keep the name they were sent under.",
  // TODO(i18n-hi)
  'documents.templates.deleteConfirmTitle': "Delete the “{name}” template?",
  // TODO(i18n-hi)
  'documents.templates.deleteFailed': "Could not delete the template",
  // TODO(i18n-hi)
  'documents.templates.deleted': "Deleted “{name}”",
  // TODO(i18n-hi)
  'documents.templates.empty.description': "A template decides what a quotation, order confirmation or dispatch note looks like.",
  // TODO(i18n-hi)
  'documents.templates.empty.title': "No templates yet",
  // TODO(i18n-hi)
  'documents.templates.loadFailed': "Could not load templates",
  // TODO(i18n-hi)
  'documents.templates.ratesHidden': "Hidden",
  // TODO(i18n-hi)
  'documents.templates.ratesShown': "Shown",
  // TODO(i18n-hi)
  'documents.templates.sectionTitle': "Templates",
  // TODO(i18n-hi)
  'documents.title': "Documents",
  // TODO(i18n-hi)
  'documents.type.dispatchNote': "Dispatch note",
  // TODO(i18n-hi)
  'documents.type.orderConfirmation': "Order confirmation",
  // TODO(i18n-hi)
  'documents.type.quotation': "Quotation",
  // TODO(i18n-hi)
  'fields.action.cancel': "Cancel",
  // TODO(i18n-hi)
  'fields.action.create': "Create",
  // TODO(i18n-hi)
  'fields.action.edit': "Edit",
  // TODO(i18n-hi)
  'fields.action.moveDown': "Move down",
  // TODO(i18n-hi)
  'fields.action.moveUp': "Move up",
  // TODO(i18n-hi)
  'fields.action.remove': "Remove",
  // TODO(i18n-hi)
  'fields.action.save': "Save",
  // TODO(i18n-hi)
  'fields.col.order': "Order",
  // TODO(i18n-hi)
  'fields.conflict.notSet': "not set",
  // TODO(i18n-hi)
  'fields.conflict.overwrite': "Overwrite with mine",
  // TODO(i18n-hi)
  'fields.conflict.reload': "Reload theirs",
  // TODO(i18n-hi)
  'fields.conflict.theirs': "theirs",
  // TODO(i18n-hi)
  'fields.conflict.yours': "yours",
  // TODO(i18n-hi)
  'fields.definitions.add': "Add custom field",
  // TODO(i18n-hi)
  'fields.definitions.col.key': "Key",
  // TODO(i18n-hi)
  'fields.definitions.col.label': "Label",
  // TODO(i18n-hi)
  'fields.definitions.col.options': "Choices",
  // TODO(i18n-hi)
  'fields.definitions.col.required': "Required",
  // TODO(i18n-hi)
  'fields.definitions.col.type': "Type",
  // TODO(i18n-hi)
  'fields.definitions.delete.body': "It goes to the Recycle Bin. Answers already stored under “{key}” stay on their records untouched, and adding the field back recovers them.",
  // TODO(i18n-hi)
  'fields.definitions.delete.title': "Remove “{label}”?",
  // TODO(i18n-hi)
  'fields.definitions.edit.title': "Edit {label}",
  // TODO(i18n-hi)
  'fields.definitions.empty.description': "Add one to collect something this product has no column for.",
  // TODO(i18n-hi)
  'fields.definitions.empty.title': "No custom fields on {entity} yet",
  // TODO(i18n-hi)
  'fields.definitions.error.description': "The definitions could not be read, so nothing is shown — this is not an empty set.",
  // TODO(i18n-hi)
  'fields.definitions.field.active': "Show this field on records",
  // TODO(i18n-hi)
  'fields.definitions.field.key': "Key",
  // TODO(i18n-hi)
  'fields.definitions.field.keyHint': "What the answer is stored under on the record. Cannot be changed afterwards.",
  // TODO(i18n-hi)
  'fields.definitions.field.keyLocked': "The key is where stored answers live — only the label can change.",
  // TODO(i18n-hi)
  'fields.definitions.field.label': "Label",
  // TODO(i18n-hi)
  'fields.definitions.field.options': "Choices",
  // TODO(i18n-hi)
  'fields.definitions.field.optionsHint': "One per line. A choice field needs at least one.",
  // TODO(i18n-hi)
  'fields.definitions.field.required': "Required",
  // TODO(i18n-hi)
  'fields.definitions.field.requiredHint': "A missing answer flags the record incomplete. It never blocks a save.",
  // TODO(i18n-hi)
  'fields.definitions.field.type': "Type",
  // TODO(i18n-hi)
  'fields.definitions.field.typeLocked': "The type is fixed once answers can exist.",
  // TODO(i18n-hi)
  'fields.definitions.new.title': "New {entity} field",
  // TODO(i18n-hi)
  'fields.definitions.requiredNo': "—",
  // TODO(i18n-hi)
  'fields.definitions.requiredYes': "Required",
  // TODO(i18n-hi)
  'fields.entity.lead': "Leads",
  // TODO(i18n-hi)
  'fields.entity.order': "Orders",
  // TODO(i18n-hi)
  'fields.entity.party': "Parties",
  // TODO(i18n-hi)
  'fields.entity.product': "Products",
  // TODO(i18n-hi)
  'fields.error.delete': "Could not remove it",
  // TODO(i18n-hi)
  'fields.error.load': "Could not load the fields",
  // TODO(i18n-hi)
  'fields.error.reorder': "Could not save the new order",
  // TODO(i18n-hi)
  'fields.error.save': "Could not save",
  // TODO(i18n-hi)
  'fields.error.title': "Could not load",
  // TODO(i18n-hi)
  'fields.noAccess.description': "Ask an administrator for {permission}.",
  // TODO(i18n-hi)
  'fields.noAccess.title': "Fields are not part of your role",
  // TODO(i18n-hi)
  'fields.readOnly': "You can read these lists but not change them — that needs {permission}.",
  // TODO(i18n-hi)
  'fields.stages.action.archive': "Archive",
  // TODO(i18n-hi)
  'fields.stages.action.makeDefault': "Make default",
  // TODO(i18n-hi)
  'fields.stages.action.restore': "Bring back",
  // TODO(i18n-hi)
  'fields.stages.col.colour': "Colour",
  // TODO(i18n-hi)
  'fields.stages.col.flags': "Behaviour",
  // TODO(i18n-hi)
  'fields.stages.col.name': "Stage",
  // TODO(i18n-hi)
  'fields.stages.description': "Stages are the Kanban columns. Archiving one stops new records landing in it; everything already there keeps rendering.",
  // TODO(i18n-hi)
  'fields.stages.edit.title': "Edit {name}",
  // TODO(i18n-hi)
  'fields.stages.empty.description': "Lead and order pipelines are created with the company.",
  // TODO(i18n-hi)
  'fields.stages.empty.pipelines': "No pipelines on this company",
  // TODO(i18n-hi)
  'fields.stages.empty.title': "No stages in this pipeline",
  // TODO(i18n-hi)
  'fields.stages.error.description': "The pipelines could not be read, so nothing is shown — this is not an empty board.",
  // TODO(i18n-hi)
  'fields.stages.field.colour': "Colour",
  // TODO(i18n-hi)
  'fields.stages.field.name': "Name",
  // TODO(i18n-hi)
  'fields.stages.field.terminal': "Records here are finished",
  // TODO(i18n-hi)
  'fields.stages.field.terminalHint': "Won, lost or dispatched — nothing further is expected.",
  // TODO(i18n-hi)
  'fields.stages.flag.archived': "Archived",
  // TODO(i18n-hi)
  'fields.stages.flag.default': "Default",
  // TODO(i18n-hi)
  'fields.stages.flag.terminal': "Finished",
  // TODO(i18n-hi)
  'fields.stages.refusal.default': "The default stage cannot be archived — new records need somewhere to land. Make another stage the default first.",
  // TODO(i18n-hi)
  'fields.stages.refusal.moveTo': "The default stage, “{target}”, is where they would normally go.",
  // TODO(i18n-hi)
  'fields.stages.refusal.occupied': "“{stage}” still holds {leads} leads and {orders} orders. Move them out and it can be archived.",
  // TODO(i18n-hi)
  'fields.status.active': "In pickers",
  // TODO(i18n-hi)
  'fields.status.inactive': "Hidden",
  // TODO(i18n-hi)
  'fields.tab.definitions': "Custom fields",
  // TODO(i18n-hi)
  'fields.tab.stages': "Pipeline stages",
  // TODO(i18n-hi)
  'fields.tab.values': "Option lists",
  // TODO(i18n-hi)
  'fields.title': "Fields",
  // TODO(i18n-hi)
  'fields.type.boolean': "Yes / no",
  // TODO(i18n-hi)
  'fields.type.date': "Date",
  // TODO(i18n-hi)
  'fields.type.number': "Number",
  // TODO(i18n-hi)
  'fields.type.select': "Choice",
  // TODO(i18n-hi)
  'fields.type.text': "Text",
  // TODO(i18n-hi)
  'fields.usedBy.inventory': "inventory",
  // TODO(i18n-hi)
  'fields.usedBy.label': "Used by {sources}",
  // TODO(i18n-hi)
  'fields.usedBy.leads': "leads",
  // TODO(i18n-hi)
  'fields.usedBy.orders': "orders",
  // TODO(i18n-hi)
  'fields.usedBy.products': "products",
  // TODO(i18n-hi)
  'fields.values.add': "Add value",
  // TODO(i18n-hi)
  'fields.values.col.colour': "Colour",
  // TODO(i18n-hi)
  'fields.values.col.label': "Label",
  // TODO(i18n-hi)
  'fields.values.col.status': "Status",
  // TODO(i18n-hi)
  'fields.values.col.usage': "On records",
  // TODO(i18n-hi)
  'fields.values.col.value': "Value",
  // TODO(i18n-hi)
  'fields.values.delete.body': "It goes to the Recycle Bin and can be restored. Every record already holding “{value}” keeps that exact string — what changes is only that new records are no longer offered it.",
  // TODO(i18n-hi)
  'fields.values.delete.title': "Remove “{label}”?",
  // TODO(i18n-hi)
  'fields.values.edit.title': "Edit {label}",
  // TODO(i18n-hi)
  'fields.values.empty.description': "Add a value and it becomes a choice everywhere this list is used.",
  // TODO(i18n-hi)
  'fields.values.empty.title': "Nothing in this list yet",
  // TODO(i18n-hi)
  'fields.values.error.description': "The list could not be read, so nothing is shown — this is not an empty list.",
  // TODO(i18n-hi)
  'fields.values.field.active': "Offer this in pickers",
  // TODO(i18n-hi)
  'fields.values.field.activeHint': "Turning this off hides it from new records. Records already holding it keep showing it.",
  // TODO(i18n-hi)
  'fields.values.field.hex': "Colour",
  // TODO(i18n-hi)
  'fields.values.field.hexHint': "Six hex digits, e.g. {example}. Leave empty for no swatch.",
  // TODO(i18n-hi)
  'fields.values.field.hexInvalid': "Use six hex digits after a #, e.g. {example}.",
  // TODO(i18n-hi)
  'fields.values.field.label': "Label",
  // TODO(i18n-hi)
  'fields.values.field.labelHint': "What people read. Safe to rename at any time.",
  // TODO(i18n-hi)
  'fields.values.field.value': "Value",
  // TODO(i18n-hi)
  'fields.values.field.valueHint': "What gets written onto the record. Cannot be changed afterwards.",
  // TODO(i18n-hi)
  'fields.values.field.valueLocked': "The value is what records already hold — only the label can change.",
  // TODO(i18n-hi)
  'fields.values.new.title': "New {set} value",
  // TODO(i18n-hi)
  'fields.values.unlisted.description': "These strings sit on live records but have no entry here, so nothing offers them for a new record. Add one to put it back in the pickers.",
  // TODO(i18n-hi)
  'fields.values.unlisted.item': "{value} · {count}",
  // TODO(i18n-hi)
  'fields.values.unlisted.title': "Already on records, not in the list",
  // TODO(i18n-hi)
  'firstRun.choose.back': "Back",
  // TODO(i18n-hi)
  'firstRun.choose.newSite': "Set up new site",
  // TODO(i18n-hi)
  'firstRun.choose.restore': "Restore from backup",
  // TODO(i18n-hi)
  'firstRun.error.default': "Setup failed",
  // TODO(i18n-hi)
  'firstRun.ready.addressLabel': "Master address",
  // TODO(i18n-hi)
  'firstRun.ready.addressesLabel': "Master addresses",
  // TODO(i18n-hi)
  'firstRun.ready.continue': "I have written these down — continue to sign in",
  // TODO(i18n-hi)
  'firstRun.ready.masterIdLabel': "Master ID",
  // TODO(i18n-hi)
  'firstRun.ready.noAddress': "This PC has no network address yet — port {port}",
  // TODO(i18n-hi)
  'firstRun.ready.pairingPasswordLabel': "Pairing password",
  // TODO(i18n-hi)
  'firstRun.ready.panelsHelp': "Office Panels normally connect automatically. These details are only needed for manual connection, when automatic search is blocked on your network.",
  // TODO(i18n-hi)
  'firstRun.ready.panelsSection': "Connecting Office Panels",
  // TODO(i18n-hi)
  'firstRun.ready.passwordLabel': "Password",
  // TODO(i18n-hi)
  'firstRun.ready.signInSection': "Sign in to this Master Panel",
  // TODO(i18n-hi)
  'firstRun.ready.title': "Master Panel is ready",
  // TODO(i18n-hi)
  'firstRun.ready.usernameLabel': "Username",
  // TODO(i18n-hi)
  'firstRun.ready.writeDownWarning': "Write these down now. The two passwords are shown only on this screen and cannot be displayed again.",
  // TODO(i18n-hi)
  'firstRun.setup.companyName': "Company name (optional)",
  // TODO(i18n-hi)
  'firstRun.setup.companyNamePlaceholder': "e.g. Shree Ceramics",
  // TODO(i18n-hi)
  'firstRun.setup.description': "This PC will store all data for the software. Run this once, on the computer that stays connected to your WiFi router.",
  // TODO(i18n-hi)
  'firstRun.setup.generate': "Generate connection details",
  // TODO(i18n-hi)
  'firstRun.setup.generating': "Generating…",
  // TODO(i18n-hi)
  'firstRun.setup.title': "Set up this Master Panel",
  // TODO(i18n-hi)
  'footer.company': "Company",
  // TODO(i18n-hi)
  'footer.designSystem': "Design system",
  // TODO(i18n-hi)
  'footer.offlineSignIn': "signed in offline",
  // TODO(i18n-hi)
  'footer.signedInAs': "{name} · {role}",
  // TODO(i18n-hi)
  'inventory.action.physicalCount': "Physical count",
  // TODO(i18n-hi)
  'inventory.action.stockIn': "Stock in",
  // TODO(i18n-hi)
  'inventory.boxesFree': "{count} boxes free",
  // TODO(i18n-hi)
  'inventory.drawer.adjust': "Adjust to physical count",
  // TODO(i18n-hi)
  'inventory.drawer.ledgerEmpty.description': "Stock in, dispatch and adjustments for this colour will appear here.",
  // TODO(i18n-hi)
  'inventory.drawer.ledgerEmpty.title': "No movements yet",
  // TODO(i18n-hi)
  'inventory.drawer.ledgerTitle': "Ledger — signed, append-only",
  // TODO(i18n-hi)
  'inventory.drawer.title': "{product} — {colour}",
  // TODO(i18n-hi)
  'inventory.empty.description': "Record stock in, and it will appear here.",
  // TODO(i18n-hi)
  'inventory.empty.title': "No stock yet",
  // TODO(i18n-hi)
  'inventory.error.adjust': "Could not save the count",
  // TODO(i18n-hi)
  'inventory.error.inbound': "Could not record the incoming stock",
  // TODO(i18n-hi)
  'inventory.error.load': "Could not load inventory",
  // TODO(i18n-hi)
  'inventory.error.reorder': "Could not save the reorder level",
  // TODO(i18n-hi)
  'inventory.field.boxes': "Boxes",
  // TODO(i18n-hi)
  'inventory.field.colour': "Colour",
  // TODO(i18n-hi)
  'inventory.field.colourPlaceholder': "e.g. Ivory",
  // TODO(i18n-hi)
  'inventory.field.note': "Note",
  // TODO(i18n-hi)
  'inventory.field.notePlaceholder': "e.g. factory lot A-77, breakage",
  // TODO(i18n-hi)
  'inventory.field.product': "Product",
  // TODO(i18n-hi)
  'inventory.field.productPlaceholder': "Choose a product…",
  // TODO(i18n-hi)
  'inventory.filter.all': "All stock",
  // TODO(i18n-hi)
  'inventory.filter.lowOnly': "Low only",
  // TODO(i18n-hi)
  'inventory.filterNote': "Stock only leaves the ledger at dispatch — reservations hold it aside",
  // TODO(i18n-hi)
  'inventory.movementType.adjustment': "Adjusted",
  // TODO(i18n-hi)
  'inventory.movementType.inbound': "Stock in",
  // TODO(i18n-hi)
  'inventory.movementType.outbound': "Dispatched",
  // TODO(i18n-hi)
  'inventory.movements.description': "Every row is a signed change, never a total — which is what makes the running figure reconstructible.",
  // TODO(i18n-hi)
  'inventory.movements.empty.description': "Stock in, dispatch and adjustments will appear here.",
  // TODO(i18n-hi)
  'inventory.movements.empty.title': "No movements yet",
  // TODO(i18n-hi)
  'inventory.movements.table.change': "Change",
  // TODO(i18n-hi)
  'inventory.movements.table.colour': "Colour",
  // TODO(i18n-hi)
  'inventory.movements.table.note': "Note",
  // TODO(i18n-hi)
  'inventory.movements.table.product': "Product",
  // TODO(i18n-hi)
  'inventory.movements.table.reference': "Reference",
  // TODO(i18n-hi)
  'inventory.movements.table.type': "Type",
  // TODO(i18n-hi)
  'inventory.movements.table.when': "When",
  // TODO(i18n-hi)
  'inventory.movements.title': "Recent movements",
  // TODO(i18n-hi)
  'inventory.physicalCount.description': "Enter the number of boxes actually on the shelf — not the difference.",
  // TODO(i18n-hi)
  'inventory.physicalCount.submit': "Save count",
  // TODO(i18n-hi)
  'inventory.physicalCount.title': "Physical count",
  // TODO(i18n-hi)
  'inventory.physicalCount.titleForLine': "Physical count — {product} ({colour})",
  // TODO(i18n-hi)
  'inventory.reorderLevelLabel': "Reorder level for {product} {colour}",
  // TODO(i18n-hi)
  'inventory.search.placeholder': "Search product or colour",
  // TODO(i18n-hi)
  'inventory.section.stockLevels': "Stock levels",
  // TODO(i18n-hi)
  'inventory.status.healthy': "Healthy",
  // TODO(i18n-hi)
  'inventory.status.low': "Low",
  // TODO(i18n-hi)
  'inventory.stockIn.description': "Boxes that arrived from the factory or a purchase.",
  // TODO(i18n-hi)
  'inventory.stockIn.submit': "Add stock",
  // TODO(i18n-hi)
  'inventory.stockIn.title': "Stock in",
  // TODO(i18n-hi)
  'inventory.stockIn.titleForLine': "Stock in — {product} ({colour})",
  // TODO(i18n-hi)
  'inventory.table.code': "Code",
  // TODO(i18n-hi)
  'inventory.table.colour': "Colour",
  // TODO(i18n-hi)
  'inventory.table.free': "Free to sell",
  // TODO(i18n-hi)
  'inventory.table.onHand': "On hand",
  // TODO(i18n-hi)
  'inventory.table.product': "Product",
  // TODO(i18n-hi)
  'inventory.table.reorder': "Reorder at",
  // TODO(i18n-hi)
  'inventory.table.reserved': "Reserved",
  // TODO(i18n-hi)
  'inventory.table.status': "Status",
  // TODO(i18n-hi)
  'lead.add.details.followUp': "Follow up on",
  // TODO(i18n-hi)
  'lead.add.details.notes': "Notes",
  // TODO(i18n-hi)
  'lead.add.details.source': "Where did this come from?",
  // TODO(i18n-hi)
  'lead.add.details.title': "3. Lead details",
  // TODO(i18n-hi)
  'lead.add.errors.generic': "Could not save the lead",
  // TODO(i18n-hi)
  'lead.add.errors.missingPackaging': "Choose packaging for {names}",
  // TODO(i18n-hi)
  'lead.add.errors.missingQuantities': "Add a quantity for {names}",
  // TODO(i18n-hi)
  'lead.add.errors.noProducts': "Add at least one product",
  // TODO(i18n-hi)
  'lead.add.errors.partyRequired': "Choose a party for this lead",
  // TODO(i18n-hi)
  'lead.add.party.change': "Change",
  // TODO(i18n-hi)
  'lead.add.party.newParty': "+ New party",
  // TODO(i18n-hi)
  'lead.add.party.search': "Search party by name, code or phone",
  // TODO(i18n-hi)
  'lead.add.party.searchPlaceholder': "Start typing…",
  // TODO(i18n-hi)
  'lead.add.party.title': "1. Party",
  // TODO(i18n-hi)
  'lead.add.party.useRates': "Use this party's own rates and specs where they exist",
  // TODO(i18n-hi)
  'lead.add.products.add': "Add",
  // TODO(i18n-hi)
  'lead.add.products.byCode': "Add by product code",
  // TODO(i18n-hi)
  'lead.add.products.byCodePlaceholder': "e.g. {example}",
  // TODO(i18n-hi)
  'lead.add.products.freeToSell': "Free to sell",
  // TODO(i18n-hi)
  'lead.add.products.grade': "Grade",
  // TODO(i18n-hi)
  'lead.add.products.keyboardHint': "Tab moves down the quantity column · ↑↓ adjust by 1 · Shift ±10",
  // TODO(i18n-hi)
  'lead.add.products.packagingPlaceholder': "e.g. carton, pallet",
  // TODO(i18n-hi)
  'lead.add.products.packagingRequired': "Packaging *",
  // TODO(i18n-hi)
  'lead.add.products.partyRate': "party rate",
  // TODO(i18n-hi)
  'lead.add.products.rate': "Rate per box",
  // TODO(i18n-hi)
  'lead.add.products.rateHint': "Your role cannot set rates",
  // TODO(i18n-hi)
  'lead.add.products.remove': "Remove",
  // TODO(i18n-hi)
  'lead.add.products.searchLabel': "Or search by name, alias, type or series",
  // TODO(i18n-hi)
  'lead.add.products.searchPlaceholder': "Start typing…",
  // TODO(i18n-hi)
  'lead.add.products.short': "short",
  // TODO(i18n-hi)
  'lead.add.products.size': "Size",
  // TODO(i18n-hi)
  'lead.add.products.title': "2. Products",
  // TODO(i18n-hi)
  'lead.add.products.useSuggested': "Use “{value}”",
  // TODO(i18n-hi)
  'lead.add.save': "Save lead",
  // TODO(i18n-hi)
  'lead.add.saving': "Saving…",
  // TODO(i18n-hi)
  'lead.add.savingHint': "Saves on this machine first — offline is the normal path",
  // TODO(i18n-hi)
  'lead.add.title': "New lead",
  // TODO(i18n-hi)
  'lead.add.total': "Total: {amount}",
  // TODO(i18n-hi)
  'lead.badge.converted': "converted",
  // TODO(i18n-hi)
  'lead.badge.incomplete': "incomplete",
  // TODO(i18n-hi)
  'lead.badge.notSynced': "not synced",
  // TODO(i18n-hi)
  'lead.board.cardMenu': "Lead actions",
  // TODO(i18n-hi)
  'lead.board.convertedNote': "Converted leads leave the board",
  // TODO(i18n-hi)
  'lead.board.convertedToast': "Converted — {boxes} boxes reserved as {orderId}",
  // TODO(i18n-hi)
  'lead.board.emptyColumn': "No leads at this stage.",
  // TODO(i18n-hi)
  'lead.board.emptyDesc': "Leads you create appear here, online or off.",
  // TODO(i18n-hi)
  'lead.board.emptyTitle': "No leads yet",
  // TODO(i18n-hi)
  'lead.board.filter.all': "All stages",
  // TODO(i18n-hi)
  'lead.board.menu.convert': "Convert to order",
  // TODO(i18n-hi)
  'lead.board.menu.convertBlocked': "Choose packaging before converting",
  // TODO(i18n-hi)
  'lead.board.menu.moveTo': "Move to {stage}",
  // TODO(i18n-hi)
  'lead.board.menu.open': "Open",
  // TODO(i18n-hi)
  'lead.board.noPipelineDesc': "The lead pipeline configuration has not arrived from the Master Panel yet.",
  // TODO(i18n-hi)
  'lead.board.noPipelineTitle': "Waiting for the pipeline",
  // TODO(i18n-hi)
  'lead.board.tab.board': "Board",
  // TODO(i18n-hi)
  'lead.board.tab.list': "List",
  // TODO(i18n-hi)
  'lead.detail.addNote': "Add",
  // TODO(i18n-hi)
  'lead.detail.addNotePlaceholder': "Add a note…",
  // TODO(i18n-hi)
  'lead.detail.city': "City",
  // TODO(i18n-hi)
  'lead.detail.code': "Code",
  // TODO(i18n-hi)
  'lead.detail.convertAction': "Convert to order",
  // TODO(i18n-hi)
  'lead.detail.convertDesc': "Creates an order with these lines copied exactly as they stand, and reserves the stock for each colour.",
  // TODO(i18n-hi)
  'lead.detail.convertMissingPackaging': "Choose packaging for {names} first — it is never filled in automatically.",
  // TODO(i18n-hi)
  'lead.detail.convertTitle': "Convert to order",
  // TODO(i18n-hi)
  'lead.detail.convertedMessage': "This lead became order {orderId}.",
  // TODO(i18n-hi)
  'lead.detail.created': "Created",
  // TODO(i18n-hi)
  'lead.detail.details': "Details",
  // TODO(i18n-hi)
  'lead.detail.dispatchLabel': "Dispatch address label",
  // TODO(i18n-hi)
  'lead.detail.expectedDate': "Expected dispatch date",
  // TODO(i18n-hi)
  'lead.detail.followUp': "Follow up",
  // TODO(i18n-hi)
  'lead.detail.history': "History",
  // TODO(i18n-hi)
  'lead.detail.incompleteWarning': "Missing required information: {fields}. The lead is saved — fill this in when you can.",
  // TODO(i18n-hi)
  'lead.detail.lineItems': "Line items",
  // TODO(i18n-hi)
  'lead.detail.name': "Name",
  // TODO(i18n-hi)
  'lead.detail.no': "No",
  // TODO(i18n-hi)
  'lead.detail.noHistory': "Nothing recorded yet.",
  // TODO(i18n-hi)
  'lead.detail.noPermission': "Your role does not include lead.convert.",
  // TODO(i18n-hi)
  'lead.detail.packagingNotChosen': "not chosen",
  // TODO(i18n-hi)
  'lead.detail.party': "Party",
  // TODO(i18n-hi)
  'lead.detail.partyRates': "Party rates",
  // TODO(i18n-hi)
  'lead.detail.phone': "Phone",
  // TODO(i18n-hi)
  'lead.detail.source': "Source",
  // TODO(i18n-hi)
  'lead.detail.stageLabel': "Move this lead to",
  // TODO(i18n-hi)
  'lead.detail.total': "Lead total",
  // TODO(i18n-hi)
  'lead.detail.yes': "Yes",
  // TODO(i18n-hi)
  'lead.list.col.amount': "Amount",
  // TODO(i18n-hi)
  'lead.list.col.boxes': "Boxes",
  // TODO(i18n-hi)
  'lead.list.col.followUp': "Follow up",
  // TODO(i18n-hi)
  'lead.list.col.lead': "Lead",
  // TODO(i18n-hi)
  'lead.list.col.party': "Party",
  // TODO(i18n-hi)
  'lead.list.col.source': "Source",
  // TODO(i18n-hi)
  'lead.list.col.stage': "Stage",
  // TODO(i18n-hi)
  'lead.list.col.sync': "Sync",
  // TODO(i18n-hi)
  'lead.list.pending': "pending",
  // TODO(i18n-hi)
  'lead.list.synced': "synced",
  // TODO(i18n-hi)
  'leadsOrders.error.convert': "Could not convert the lead",
  // TODO(i18n-hi)
  'leadsOrders.error.dispatch': "Could not dispatch the order",
  // TODO(i18n-hi)
  'leadsOrders.error.load': "Could not load",
  // TODO(i18n-hi)
  'leadsOrders.error.moveLead': "Could not move the lead",
  // TODO(i18n-hi)
  'leadsOrders.error.moveOrder': "Could not move the order",
  // TODO(i18n-hi)
  'leadsOrders.leads.column.amount': "Amount",
  // TODO(i18n-hi)
  'leadsOrders.leads.column.created': "Created",
  // TODO(i18n-hi)
  'leadsOrders.leads.column.lead': "Lead",
  // TODO(i18n-hi)
  'leadsOrders.leads.column.party': "Party",
  // TODO(i18n-hi)
  'leadsOrders.leads.column.products': "Products",
  // TODO(i18n-hi)
  'leadsOrders.leads.column.stage': "Stage",
  // TODO(i18n-hi)
  'leadsOrders.leads.convert': "Convert to order",
  // TODO(i18n-hi)
  'leadsOrders.leads.convertBlocked': "Every line needs packaging before this can become an order",
  // TODO(i18n-hi)
  'leadsOrders.leads.converted': "converted",
  // TODO(i18n-hi)
  'leadsOrders.leads.convertedOrder': "order {id}",
  // TODO(i18n-hi)
  'leadsOrders.leads.empty.converted.title': "No converted leads yet",
  // TODO(i18n-hi)
  'leadsOrders.leads.empty.open.description': "Office Panels raise them.",
  // TODO(i18n-hi)
  'leadsOrders.leads.empty.open.title': "No open leads",
  // TODO(i18n-hi)
  'leadsOrders.leads.incomplete': "incomplete",
  // TODO(i18n-hi)
  'leadsOrders.orders.column.amount': "Amount",
  // TODO(i18n-hi)
  'leadsOrders.orders.column.fromLead': "From lead",
  // TODO(i18n-hi)
  'leadsOrders.orders.column.order': "Order",
  // TODO(i18n-hi)
  'leadsOrders.orders.column.party': "Party",
  // TODO(i18n-hi)
  'leadsOrders.orders.column.products': "Products",
  // TODO(i18n-hi)
  'leadsOrders.orders.column.stage': "Stage",
  // TODO(i18n-hi)
  'leadsOrders.orders.column.weight': "Weight",
  // TODO(i18n-hi)
  'leadsOrders.orders.dispatch': "Dispatch",
  // TODO(i18n-hi)
  'leadsOrders.orders.dispatched': "Dispatched {when}",
  // TODO(i18n-hi)
  'leadsOrders.orders.empty.description': "They appear here once a lead is converted.",
  // TODO(i18n-hi)
  'leadsOrders.orders.empty.title': "No orders yet",
  // TODO(i18n-hi)
  'leadsOrders.orders.weightManual': "Entered by hand, not summed from the lines",
  // TODO(i18n-hi)
  'leadsOrders.tab.converted': "Converted leads",
  // TODO(i18n-hi)
  'leadsOrders.tab.leads': "Open leads",
  // TODO(i18n-hi)
  'leadsOrders.tab.orders': "Orders",
  // TODO(i18n-hi)
  'leadsOrders.title': "Leads & orders",
  // TODO(i18n-hi)
  'leadsOrders.unit.kg': "kg",
  // TODO(i18n-hi)
  'logs.action.export': "Export CSV",
  // TODO(i18n-hi)
  'logs.action.verify': "Verify chain",
  // TODO(i18n-hi)
  'logs.actorType.office_panel': "An office panel",
  // TODO(i18n-hi)
  'logs.actorType.system': "The system",
  // TODO(i18n-hi)
  'logs.actorType.user': "A person",
  // TODO(i18n-hi)
  'logs.chain.preChain': "pre-chain",
  // TODO(i18n-hi)
  'logs.chain.preChainHint': "Recorded before hash chaining — unverifiable, not broken",
  // TODO(i18n-hi)
  'logs.drawer.details': "Recorded details",
  // TODO(i18n-hi)
  'logs.drawer.entryId': "Entry",
  // TODO(i18n-hi)
  'logs.drawer.hash': "Hash",
  // TODO(i18n-hi)
  'logs.drawer.noDetails': "This entry carries no extra detail.",
  // TODO(i18n-hi)
  'logs.drawer.record': "Record",
  // TODO(i18n-hi)
  'logs.drawer.sequence': "Sequence",
  // TODO(i18n-hi)
  'logs.drawer.token': "Token",
  // TODO(i18n-hi)
  'logs.drawer.when': "When",
  // TODO(i18n-hi)
  'logs.drawer.who': "Who",
  // TODO(i18n-hi)
  'logs.empty.description': "Every change made in this panel or an office panel appears here.",
  // TODO(i18n-hi)
  'logs.empty.title': "Nothing recorded yet",
  // TODO(i18n-hi)
  'logs.emptyFiltered.description': "Widen the date range, or clear the filters.",
  // TODO(i18n-hi)
  'logs.emptyFiltered.title': "No entries match those filters",
  // TODO(i18n-hi)
  'logs.error.retry': "Try again",
  // TODO(i18n-hi)
  'logs.error.title': "Could not load the activity log",
  // TODO(i18n-hi)
  'logs.filter.actionAll': "All actions",
  // TODO(i18n-hi)
  'logs.filter.actionLabel': "Filter by action",
  // TODO(i18n-hi)
  'logs.filter.actorAll': "Anyone",
  // TODO(i18n-hi)
  'logs.filter.actorLabel': "Filter by who",
  // TODO(i18n-hi)
  'logs.filter.clear': "Clear filters",
  // TODO(i18n-hi)
  'logs.filter.entityAll': "All record types",
  // TODO(i18n-hi)
  'logs.filter.entityLabel': "Filter by record type",
  // TODO(i18n-hi)
  'logs.filter.facetsUnavailable': "Could not load the filter choices",
  // TODO(i18n-hi)
  'logs.filter.fromLabel': "From date",
  // TODO(i18n-hi)
  'logs.filter.searchPlaceholder': "Search records and details",
  // TODO(i18n-hi)
  'logs.filter.toLabel': "To date",
  // TODO(i18n-hi)
  'logs.noPermission.description': "Your role does not include {permission}.",
  // TODO(i18n-hi)
  'logs.noPermission.title': "You cannot see the activity log",
  // TODO(i18n-hi)
  'logs.section.description': "Append-only and hash-chained: every entry seals the one before it, so a row cannot be altered or removed without the chain saying so.",
  // TODO(i18n-hi)
  'logs.section.title': "Activity log",
  // TODO(i18n-hi)
  'logs.table.record': "Record",
  // TODO(i18n-hi)
  'logs.table.sequence': "Seq.",
  // TODO(i18n-hi)
  'logs.table.what': "What happened",
  // TODO(i18n-hi)
  'logs.table.when': "When",
  // TODO(i18n-hi)
  'logs.table.who': "Who",
  // TODO(i18n-hi)
  'logs.verify.break.hash_mismatch': "The entry's own hash does not match its contents.",
  // TODO(i18n-hi)
  'logs.verify.break.prev_hash_mismatch': "The entry does not seal the one before it — an entry was replaced or inserted.",
  // TODO(i18n-hi)
  'logs.verify.break.sequence_gap': "An entry is missing from the sequence.",
  // TODO(i18n-hi)
  'logs.verify.breakAt': "First break",
  // TODO(i18n-hi)
  'logs.verify.breakDetail': "entry {id}, recorded {when}",
  // TODO(i18n-hi)
  'logs.verify.broken': "Tampering detected. The chain first breaks at sequence {sequence}.",
  // TODO(i18n-hi)
  'logs.verify.checked': "Entries checked",
  // TODO(i18n-hi)
  'logs.verify.close': "Close",
  // TODO(i18n-hi)
  'logs.verify.failed': "Could not verify the chain",
  // TODO(i18n-hi)
  'logs.verify.ok': "Intact — every hash in the range recomputes to what is stored.",
  // TODO(i18n-hi)
  'logs.verify.range': "Range checked",
  // TODO(i18n-hi)
  'logs.verify.rangeEmpty': "Nothing to check — the log is empty.",
  // TODO(i18n-hi)
  'logs.verify.rangeValue': "sequence {from} to {to}",
  // TODO(i18n-hi)
  'logs.verify.running': "Recomputing every hash in the range…",
  // TODO(i18n-hi)
  'logs.verify.skipped': "Skipped as pre-chain",
  // TODO(i18n-hi)
  'logs.verify.title': "Audit chain verification",
  // TODO(i18n-hi)
  'logs.verify.truncated': "Only the most recent stretch was checked — the range was capped to keep the scan bounded.",
  // TODO(i18n-hi)
  'master.app.panel': "Master Panel",
  // TODO(i18n-hi)
  'master.backup.export.title': "Export whole data",
  // TODO(i18n-hi)
  'master.backup.restore.confirmWipe': "This installation already has data. Restoring will replace it completely. Type CONFIRM to proceed.",
  // TODO(i18n-hi)
  'master.search.failedOffline': "Can't search right now — try again in a moment.",
  // TODO(i18n-hi)
  'master.settings.storage.title': "Storage on this PC",
  // TODO(i18n-hi)
  'master.sync.conflictReview': "{count} conflicts — review",
  // TODO(i18n-hi)
  'master.sync.offline': "{count} offline",
  // TODO(i18n-hi)
  'master.sync.offlinePending': "{count} offline — {pending} pending",
  // TODO(i18n-hi)
  'master.sync.pendingChanges': "Changes waiting on panels",
  // TODO(i18n-hi)
  'master.sync.popoverTitle.offline': "Panels unreachable",
  // TODO(i18n-hi)
  'master.sync.popoverTitle.offlinePending': "Panels unreachable — changes pending",
  // TODO(i18n-hi)
  'master.sync.popoverTitle.synced': "Everything synced",
  // TODO(i18n-hi)
  'nav.catalogue': "Catalogue",
  // TODO(i18n-hi)
  'nav.conflicts': "Conflicts",
  // TODO(i18n-hi)
  'nav.dashboard': "Dashboard",
  // TODO(i18n-hi)
  'nav.leads': "Leads",
  // TODO(i18n-hi)
  'nav.master.access': "Roles & users",
  // TODO(i18n-hi)
  'nav.master.admin': "Admin",
  // TODO(i18n-hi)
  'nav.master.conflicts': "Conflicts",
  // TODO(i18n-hi)
  'nav.master.dashboard': "Dashboard",
  // TODO(i18n-hi)
  'nav.master.documents': "Documents",
  // TODO(i18n-hi)
  'nav.master.editRole': "Edit role · {name}",
  // TODO(i18n-hi)
  'nav.master.editUser': "Edit person · {name}",
  // TODO(i18n-hi)
  'nav.master.fields': "Fields",
  // TODO(i18n-hi)
  'nav.master.inventory': "Inventory",
  // TODO(i18n-hi)
  'nav.master.leadsOrders': "Leads & orders",
  // TODO(i18n-hi)
  'nav.master.logs': "Activity log",
  // TODO(i18n-hi)
  'nav.master.panels': "Office panels",
  // TODO(i18n-hi)
  'nav.master.partyAccess': "Party access",
  // TODO(i18n-hi)
  'nav.master.recycleBin': "Recycle bin",
  // TODO(i18n-hi)
  'nav.master.reports': "Reports",
  // TODO(i18n-hi)
  'nav.master.settings': "Settings",
  // TODO(i18n-hi)
  'nav.master.work': "Work",
  // TODO(i18n-hi)
  'nav.orders': "Orders",
  // TODO(i18n-hi)
  'nav.parties': "Parties",
  // TODO(i18n-hi)
  'nav.partyAccess': "Party access",
  // TODO(i18n-hi)
  'nav.products': "Products",
  // TODO(i18n-hi)
  'nav.settings': "Settings",
  // TODO(i18n-hi)
  'nav.system': "System",
  // TODO(i18n-hi)
  'nav.updates': "App update",
  // TODO(i18n-hi)
  'nav.work': "Work",
  // TODO(i18n-hi)
  'office.app.panel': "Office Panel",
  // TODO(i18n-hi)
  'office.backup.export.title': "Export this device",
  // TODO(i18n-hi)
  'office.backup.restore.confirmWipe': "This device already has data. Restoring will replace it completely. Type CONFIRM to proceed.",
  // TODO(i18n-hi)
  'office.search.failedOffline': "Can't search while the Master is unreachable — try again once it's back.",
  // TODO(i18n-hi)
  'office.settings.storage.title': "Storage on this device",
  // TODO(i18n-hi)
  'office.sync.conflictReview': "{count} fields resolved — review",
  // TODO(i18n-hi)
  'office.sync.offline': "Offline",
  // TODO(i18n-hi)
  'office.sync.offlinePending': "Offline — {count} pending",
  // TODO(i18n-hi)
  'office.sync.pendingChanges': "Pending changes",
  // TODO(i18n-hi)
  'office.sync.popoverTitle.offline': "Offline",
  // TODO(i18n-hi)
  'office.sync.popoverTitle.offlinePending': "Offline — pending changes",
  // TODO(i18n-hi)
  'office.sync.popoverTitle.synced': "Synced",
  // TODO(i18n-hi)
  'orders.badge.dispatched': "dispatched",
  // TODO(i18n-hi)
  'orders.column.amount': "Amount",
  // TODO(i18n-hi)
  'orders.column.boxes': "Boxes",
  // TODO(i18n-hi)
  'orders.column.colour': "Colour",
  // TODO(i18n-hi)
  'orders.column.colours': "Colours",
  // TODO(i18n-hi)
  'orders.column.fromLead': "From lead",
  // TODO(i18n-hi)
  'orders.column.order': "Order",
  // TODO(i18n-hi)
  'orders.column.packaging': "Packaging",
  // TODO(i18n-hi)
  'orders.column.party': "Party",
  // TODO(i18n-hi)
  'orders.column.product': "Product",
  // TODO(i18n-hi)
  'orders.column.stage': "Stage",
  // TODO(i18n-hi)
  'orders.column.status': "Status",
  // TODO(i18n-hi)
  'orders.column.sync': "Sync",
  // TODO(i18n-hi)
  'orders.column.weight': "Weight",
  // TODO(i18n-hi)
  'orders.detail.dispatch': "Dispatch",
  // TODO(i18n-hi)
  'orders.detail.dispatchButton': "Mark dispatched",
  // TODO(i18n-hi)
  'orders.detail.dispatchNote': "Takes {count} reservation(s) off the stock ledger. This cannot be undone from here.",
  // TODO(i18n-hi)
  'orders.detail.dispatchNoteLabel': "Note",
  // TODO(i18n-hi)
  'orders.detail.dispatchNotePlaceholder': "e.g. lorry AB-12",
  // TODO(i18n-hi)
  'orders.detail.dispatchedBanner': "Dispatched {when} — reservations consumed, ledger entries written.",
  // TODO(i18n-hi)
  'orders.detail.history': "History",
  // TODO(i18n-hi)
  'orders.detail.lineTotal': "Line total",
  // TODO(i18n-hi)
  'orders.detail.noDispatchPermission': "Your role does not include {permission}.",
  // TODO(i18n-hi)
  'orders.detail.noReservations': "No reservations.",
  // TODO(i18n-hi)
  'orders.detail.products': "Products",
  // TODO(i18n-hi)
  'orders.detail.reservations': "Stock held for this order",
  // TODO(i18n-hi)
  'orders.detail.stage': "Stage",
  // TODO(i18n-hi)
  'orders.detail.stageLabel': "Move this order to",
  // TODO(i18n-hi)
  'orders.detail.subtitleNoLead': "{id}",
  // TODO(i18n-hi)
  'orders.detail.subtitleWithLead': "{id} · from {leadId}",
  // TODO(i18n-hi)
  'orders.detail.weight': "Weight",
  // TODO(i18n-hi)
  'orders.detail.weightComputed': "Computed from the lines: {value} kg",
  // TODO(i18n-hi)
  'orders.detail.weightOverrideLabel': "Override (leave blank to use the computed figure)",
  // TODO(i18n-hi)
  'orders.detail.weightOverridePlaceholder': "Override",
  // TODO(i18n-hi)
  'orders.detail.weightShowing': "Showing the {source} figure.",
  // TODO(i18n-hi)
  'orders.empty.description': "Orders converted from leads appear here.",
  // TODO(i18n-hi)
  'orders.empty.filteredTitle': "No orders at this stage.",
  // TODO(i18n-hi)
  'orders.empty.title': "No orders yet",
  // TODO(i18n-hi)
  'orders.filter.allStages': "All stages",
  // TODO(i18n-hi)
  'orders.filter.note': "Dispatch consumes reservations — it cannot be undone here",
  // TODO(i18n-hi)
  'orders.reservation.status.active': "Active",
  // TODO(i18n-hi)
  'orders.reservation.status.consumed': "Consumed",
  // TODO(i18n-hi)
  'orders.reservation.status.released': "Released",
  // TODO(i18n-hi)
  'orders.sync.pending': "Not synced",
  // TODO(i18n-hi)
  'orders.sync.synced': "Synced",
  // TODO(i18n-hi)
  'orders.unit.kg': "kg",
  // TODO(i18n-hi)
  'orders.waitingPipeline': "Waiting for the pipeline configuration from the Master Panel…",
  // TODO(i18n-hi)
  'panel.access.description': "When nobody is signed in at that desk, the panel still acts — accepting a lead, syncing what it holds. This is the role it acts under then. A person signed in on the panel always acts under their own role instead.",
  // TODO(i18n-hi)
  'panel.access.fallback': "Office (the default)",
  // TODO(i18n-hi)
  'panel.access.fallbackHint': "No role chosen, so the seeded Office role stands in.",
  // TODO(i18n-hi)
  'panel.access.permissionCount': "{count} permissions",
  // TODO(i18n-hi)
  'panel.access.permissions': "That role may",
  // TODO(i18n-hi)
  'panel.access.role': "Role for the unattended panel",
  // TODO(i18n-hi)
  'panel.access.save': "Save the role",
  // TODO(i18n-hi)
  'panel.access.tier': "Tier",
  // TODO(i18n-hi)
  'panel.access.title': "What this panel may do on its own",
  // TODO(i18n-hi)
  'panel.action.refresh': "Refresh from the panel",
  // TODO(i18n-hi)
  'panel.action.refreshed': "Updated from {name}",
  // TODO(i18n-hi)
  'panel.back': "All panels",
  // TODO(i18n-hi)
  'panel.credentials.description': "A panel proves itself to the Master with its ID and a secret. The ID never changes; the secret can be reissued at any time.",
  // TODO(i18n-hi)
  'panel.credentials.neverRotated': "Unchanged since this panel was paired.",
  // TODO(i18n-hi)
  'panel.credentials.new.close': "I have written it down",
  // TODO(i18n-hi)
  'panel.credentials.new.delivered': "The panel has already taken it and is still connected — there is nothing further to do.",
  // TODO(i18n-hi)
  'panel.credentials.new.once': "This is shown once and is not stored anywhere. Write it down before closing.",
  // TODO(i18n-hi)
  'panel.credentials.new.title': "The new secret for {name}",
  // TODO(i18n-hi)
  'panel.credentials.new.undelivered': "The panel was offline. Enter this on that PC’s Manual Connection screen to bring it back.",
  // TODO(i18n-hi)
  'panel.credentials.pairing.description': "The one an operator types on a panel’s Manual Connection screen belongs to this Master, not to any one panel. It is on the Settings screen.",
  // TODO(i18n-hi)
  'panel.credentials.pairing.title': "Pairing password",
  // TODO(i18n-hi)
  'panel.credentials.rotate': "Reissue the secret",
  // TODO(i18n-hi)
  'panel.credentials.rotate.confirm': "Reissue it",
  // TODO(i18n-hi)
  'panel.credentials.rotate.connected': "That panel is connected, so it will be handed the new secret and carry on working. Nobody has to touch that PC.",
  // TODO(i18n-hi)
  'panel.credentials.rotate.failed': "Could not reissue the secret",
  // TODO(i18n-hi)
  'panel.credentials.rotate.offline': "That panel is offline and cannot be told. It will be locked out until somebody pairs that PC again by hand.",
  // TODO(i18n-hi)
  'panel.credentials.rotate.title': "Reissue the secret for {name}?",
  // TODO(i18n-hi)
  'panel.credentials.rotatedAt': "Last reissued {when}",
  // TODO(i18n-hi)
  'panel.credentials.secretLabel': "Secret",
  // TODO(i18n-hi)
  'panel.credentials.secretStored': "Stored as a hash — it cannot be read back, only replaced.",
  // TODO(i18n-hi)
  'panel.credentials.title': "How this panel signs in",
  // TODO(i18n-hi)
  'panel.danger.disconnect': "Drop the connection",
  // TODO(i18n-hi)
  'panel.danger.disconnectFailed': "Could not drop that connection",
  // TODO(i18n-hi)
  'panel.danger.disconnectHint': "Ends the panel’s current link. It reconnects on its own within seconds — a way to clear a stuck session without going to that PC.",
  // TODO(i18n-hi)
  'panel.danger.disconnected': "Dropped {name}’s connection",
  // TODO(i18n-hi)
  'panel.danger.remove': "Remove this panel",
  // TODO(i18n-hi)
  'panel.danger.removeHint': "Ends the pairing for good. That PC drops to its connection screen and has to be paired again.",
  // TODO(i18n-hi)
  'panel.danger.title': "Connection",
  // TODO(i18n-hi)
  'panel.field.address': "Address on the network",
  // TODO(i18n-hi)
  'panel.field.appVersion': "OrderBook version",
  // TODO(i18n-hi)
  'panel.field.deviceCode': "Device code",
  // TODO(i18n-hi)
  'panel.field.deviceCodeHint': "Stamped into every record this panel raises offline.",
  // TODO(i18n-hi)
  'panel.field.hostname': "PC name",
  // TODO(i18n-hi)
  'panel.field.lastAction': "Last action",
  // TODO(i18n-hi)
  'panel.field.leads': "Leads raised",
  // TODO(i18n-hi)
  'panel.field.localPort': "Opens in a browser at",
  // TODO(i18n-hi)
  'panel.field.name': "Name",
  // TODO(i18n-hi)
  'panel.field.nobody': "Nobody",
  // TODO(i18n-hi)
  'panel.field.nodeVersion': "Node version",
  // TODO(i18n-hi)
  'panel.field.notes': "Note",
  // TODO(i18n-hi)
  'panel.field.notesHint': "Where this PC is, or who uses it. Only the Master shows this.",
  // TODO(i18n-hi)
  'panel.field.orders': "Orders raised",
  // TODO(i18n-hi)
  'panel.field.paired': "Paired",
  // TODO(i18n-hi)
  'panel.field.panelId': "Panel ID",
  // TODO(i18n-hi)
  'panel.field.pendingMutations': "Changes waiting to reach here",
  // TODO(i18n-hi)
  'panel.field.platform': "System",
  // TODO(i18n-hi)
  'panel.field.signedInUser': "Signed in on that PC",
  // TODO(i18n-hi)
  'panel.field.snapshotAt': "Copy of the data dated",
  // TODO(i18n-hi)
  'panel.field.startedAt': "Running since",
  // TODO(i18n-hi)
  'panel.field.unknown': "Not reported yet",
  // TODO(i18n-hi)
  'panel.load.failed': "Could not open that panel",
  // TODO(i18n-hi)
  'panel.overview.identity': "This panel",
  // TODO(i18n-hi)
  'panel.overview.link': "Connection",
  // TODO(i18n-hi)
  'panel.overview.machine': "The PC it runs on",
  // TODO(i18n-hi)
  'panel.overview.neverReported': "This panel has not described itself yet. It does so the moment it next connects.",
  // TODO(i18n-hi)
  'panel.overview.reportedAt': "Details as of {when}",
  // TODO(i18n-hi)
  'panel.overview.work': "What it has raised",
  // TODO(i18n-hi)
  'panel.refresh.offline': "That panel is offline, so these figures are the last it sent.",
  // TODO(i18n-hi)
  'panel.save.failed': "Could not save that change",
  // TODO(i18n-hi)
  'panel.status.connected': "Connected",
  // TODO(i18n-hi)
  'panel.status.connectedSince': "Connected since {when}",
  // TODO(i18n-hi)
  'panel.status.lastSeen': "Last seen {when}",
  // TODO(i18n-hi)
  'panel.status.neverSeen': "Has never connected",
  // TODO(i18n-hi)
  'panel.status.offline': "Offline",
  // TODO(i18n-hi)
  'panel.status.removed': "Removed",
  // TODO(i18n-hi)
  'panel.storage.cachedImages': "Photos cached",
  // TODO(i18n-hi)
  'panel.storage.change': "Move to another folder",
  // TODO(i18n-hi)
  'panel.storage.change.confirm': "Move the files",
  // TODO(i18n-hi)
  'panel.storage.change.description': "The panel checks the folder on its own PC and refuses if it cannot write there or the drive is too small.",
  // TODO(i18n-hi)
  'panel.storage.change.done': "Moved {count} files to {path}",
  // TODO(i18n-hi)
  'panel.storage.change.failed': "That panel could not move its files",
  // TODO(i18n-hi)
  'panel.storage.change.hint': "The full path, e.g. D:\\OrderBook\\panel-data",
  // TODO(i18n-hi)
  'panel.storage.change.label': "New folder on that PC",
  // TODO(i18n-hi)
  'panel.storage.change.move': "Copy what is already there",
  // TODO(i18n-hi)
  'panel.storage.change.moveHint': "Leave this on. Turning it off starts the panel empty and abandons any work it has not sent yet.",
  // TODO(i18n-hi)
  'panel.storage.change.oldFolder': "The old folder at {path} was left in place. Delete it from that PC once you are satisfied.",
  // TODO(i18n-hi)
  'panel.storage.change.title': "Move {name}’s files",
  // TODO(i18n-hi)
  'panel.storage.description': "An Office Panel holds no database. What lives here is its queue of unsent work, its copy of the data, and the photos it has viewed.",
  // TODO(i18n-hi)
  'panel.storage.free': "Free on that drive",
  // TODO(i18n-hi)
  'panel.storage.images': "Photo cache",
  // TODO(i18n-hi)
  'panel.storage.offline': "The folder can only be moved while that panel is connected — it is the panel that does the moving.",
  // TODO(i18n-hi)
  'panel.storage.path': "Folder on that PC",
  // TODO(i18n-hi)
  'panel.storage.title': "Where this panel keeps its files",
  // TODO(i18n-hi)
  'panel.storage.total': "Drive size",
  // TODO(i18n-hi)
  'panel.storage.used': "Used by this panel",
  // TODO(i18n-hi)
  'panel.tab.access': "What it may do",
  // TODO(i18n-hi)
  'panel.tab.activity': "Activity",
  // TODO(i18n-hi)
  'panel.tab.credentials': "ID & password",
  // TODO(i18n-hi)
  'panel.tab.overview': "Overview",
  // TODO(i18n-hi)
  'panel.tab.storage': "Storage",
  // TODO(i18n-hi)
  'panels.action.open': "Open",
  // TODO(i18n-hi)
  'panels.action.remove': "Remove",
  // TODO(i18n-hi)
  'panels.action.rename': "Rename",
  // TODO(i18n-hi)
  'panels.activity.column.what': "What happened",
  // TODO(i18n-hi)
  'panels.activity.column.when': "When",
  // TODO(i18n-hi)
  'panels.activity.column.who': "Who",
  // TODO(i18n-hi)
  'panels.activity.denied': "Your role does not include {permission}, so the trail is hidden.",
  // TODO(i18n-hi)
  'panels.activity.empty.description': "Work raised at a panel, and changes made to one, appear here.",
  // TODO(i18n-hi)
  'panels.activity.empty.title': "Nothing recorded yet",
  // TODO(i18n-hi)
  'panels.activity.error': "Could not read the activity trail",
  // TODO(i18n-hi)
  'panels.activity.title': "Everything the panels have done",
  // TODO(i18n-hi)
  'panels.add.action': "Add Office Panel",
  // TODO(i18n-hi)
  'panels.add.cancel': "Cancel",
  // TODO(i18n-hi)
  'panels.add.description': "Press this, then start automatic connection on the office PC. This Master only accepts new panels while you are waiting here.",
  // TODO(i18n-hi)
  'panels.add.startFailed': "Could not start pairing",
  // TODO(i18n-hi)
  'panels.add.title': "Add Office Panel",
  // TODO(i18n-hi)
  'panels.add.waitingBody': "On the office PC, open the Office Panel and press \"Proceed with Auto Connection\". It will find this Master automatically.",
  // TODO(i18n-hi)
  'panels.add.waitingTitle': "Waiting for office panel…",
  // TODO(i18n-hi)
  'panels.detail.connection': "Live connection",
  // TODO(i18n-hi)
  'panels.detail.connectionDown': "Not connected",
  // TODO(i18n-hi)
  'panels.detail.connectionLive': "Connected now",
  // TODO(i18n-hi)
  'panels.detail.created': "First seen",
  // TODO(i18n-hi)
  'panels.detail.history': "History",
  // TODO(i18n-hi)
  'panels.detail.id': "Panel ID",
  // TODO(i18n-hi)
  'panels.detail.identity': "Identity",
  // TODO(i18n-hi)
  'panels.detail.mac': "MAC address",
  // TODO(i18n-hi)
  'panels.detail.network': "Network",
  // TODO(i18n-hi)
  'panels.detail.revokedNote': "This panel was removed. It has to pair again before it can connect.",
  // TODO(i18n-hi)
  'panels.detail.role': "Acts under role",
  // TODO(i18n-hi)
  'panels.detail.roleDefault': "Office (default)",
  // TODO(i18n-hi)
  'panels.detail.status.active': "Paired",
  // TODO(i18n-hi)
  'panels.detail.status.pending': "Waiting to pair",
  // TODO(i18n-hi)
  'panels.detail.status.revoked': "Removed",
  // TODO(i18n-hi)
  'panels.detail.statusLabel': "Pairing",
  // TODO(i18n-hi)
  'panels.detail.updated': "Last changed",
  // TODO(i18n-hi)
  'panels.empty.description': "Panels you pair appear here, online or off.",
  // TODO(i18n-hi)
  'panels.empty.title': "No office panels yet",
  // TODO(i18n-hi)
  'panels.list.hint': "Double-click a panel to open and manage it.",
  // TODO(i18n-hi)
  'panels.list.title': "Connected Office Panels",
  // TODO(i18n-hi)
  'panels.rename.cancel': "Cancel",
  // TODO(i18n-hi)
  'panels.rename.failed': "Could not rename the panel",
  // TODO(i18n-hi)
  'panels.rename.label': "Name for this office panel",
  // TODO(i18n-hi)
  'panels.rename.save': "Save",
  // TODO(i18n-hi)
  'panels.rename.title': "Rename \"{name}\"",
  // TODO(i18n-hi)
  'panels.revoke.body': "That PC will have to connect again.",
  // TODO(i18n-hi)
  'panels.revoke.cancel': "Cancel",
  // TODO(i18n-hi)
  'panels.revoke.failed': "Could not remove the panel",
  // TODO(i18n-hi)
  'panels.revoke.title': "Remove \"{name}\"?",
  // TODO(i18n-hi)
  'panels.section.activity': "Panel activity",
  // TODO(i18n-hi)
  'panels.section.all': "All panels",
  // TODO(i18n-hi)
  'panels.section.pairing': "Add a panel",
  // TODO(i18n-hi)
  'panels.status.connected': "Connected",
  // TODO(i18n-hi)
  'panels.status.offline': "Offline",
  // TODO(i18n-hi)
  'panels.status.removed': "Removed",
  // TODO(i18n-hi)
  'panels.summary.connected': "Connected now",
  // TODO(i18n-hi)
  'panels.summary.offline': "Offline",
  // TODO(i18n-hi)
  'panels.summary.pending': "Changes waiting",
  // TODO(i18n-hi)
  'panels.summary.total': "Paired",
  // TODO(i18n-hi)
  'panels.table.address': "Address",
  // TODO(i18n-hi)
  'panels.table.deviceCode': "Device code",
  // TODO(i18n-hi)
  'panels.table.lastSeen': "Last seen",
  // TODO(i18n-hi)
  'panels.table.machine': "PC",
  // TODO(i18n-hi)
  'panels.table.name': "Name",
  // TODO(i18n-hi)
  'panels.table.paired': "Paired",
  // TODO(i18n-hi)
  'panels.table.status': "Status",
  // TODO(i18n-hi)
  'panels.table.storage': "Storage",
  // TODO(i18n-hi)
  'party.createFailed': "Could not create the party",
  // TODO(i18n-hi)
  'party.detail.access.manage': "This party is assigned to you. You can see and change its records.",
  // TODO(i18n-hi)
  'party.detail.access.open': "Nobody is assigned, so everyone with the right role can see and work this party.",
  // TODO(i18n-hi)
  'party.detail.access.view': "You can see this party and its records, but not change them.",
  // TODO(i18n-hi)
  'party.detail.accessTitle': "Who can reach this party",
  // TODO(i18n-hi)
  'party.detail.city': "City",
  // TODO(i18n-hi)
  'party.detail.contact': "Contact",
  // TODO(i18n-hi)
  'party.detail.editAction': "Edit party",
  // TODO(i18n-hi)
  'party.detail.email': "Email",
  // TODO(i18n-hi)
  'party.detail.leads.none': "No leads yet for this party.",
  // TODO(i18n-hi)
  'party.detail.leadsTitle': "Recent leads",
  // TODO(i18n-hi)
  'party.detail.phone': "Phone",
  // TODO(i18n-hi)
  'party.detail.rates.catalogue': "Catalogue",
  // TODO(i18n-hi)
  'party.detail.rates.none': "No party rates — catalogue rates apply.",
  // TODO(i18n-hi)
  'party.detail.rates.own': "This party",
  // TODO(i18n-hi)
  'party.detail.rates.product': "Product",
  // TODO(i18n-hi)
  'party.detail.ratesTitle': "Party rates — override the catalogue",
  // TODO(i18n-hi)
  'party.detail.since': "Since",
  // TODO(i18n-hi)
  'party.detail.taxId': "Tax ID",
  // TODO(i18n-hi)
  'party.edit.title': "Edit party",
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
  'party.field.city': "City",
  // TODO(i18n-hi)
  'party.field.name': "Party name",
  // TODO(i18n-hi)
  'party.field.notes': "Notes",
  // TODO(i18n-hi)
  'party.field.phone': "Phone",
  // TODO(i18n-hi)
  'party.field.taxId': "Tax ID",
  // TODO(i18n-hi)
  'party.field.taxIdHint': "The party's GST number, if registered",
  // TODO(i18n-hi)
  'party.nameRequired': "Enter the party name",
  // TODO(i18n-hi)
  'party.new.title': "New party",
  // TODO(i18n-hi)
  'party.save': "Save party",
  // TODO(i18n-hi)
  'party.saveChanges': "Save changes",
  // TODO(i18n-hi)
  'party.saveHint': "Available in every lead form the moment it saves — online or off",
  // TODO(i18n-hi)
  'party.saving': "Saving…",
  // TODO(i18n-hi)
  'party.updated': "{name} updated",
  // TODO(i18n-hi)
  'partyAccess.action.cancel': "Cancel",
  // TODO(i18n-hi)
  'partyAccess.action.export': "Export",
  // TODO(i18n-hi)
  'partyAccess.action.save': "Save",
  // TODO(i18n-hi)
  'partyAccess.addPerson': "Add a person",
  // TODO(i18n-hi)
  'partyAccess.column.access': "Access",
  // TODO(i18n-hi)
  'partyAccess.column.assignedTo': "Assigned to",
  // TODO(i18n-hi)
  'partyAccess.column.city': "City",
  // TODO(i18n-hi)
  'partyAccess.column.code': "Code",
  // TODO(i18n-hi)
  'partyAccess.column.party': "Party",
  // TODO(i18n-hi)
  'partyAccess.empty': "No parties match this filter",
  // TODO(i18n-hi)
  'partyAccess.error.load': "Could not load party access",
  // TODO(i18n-hi)
  'partyAccess.error.save': "Could not save the assignments",
  // TODO(i18n-hi)
  'partyAccess.everyone': "Everyone",
  // TODO(i18n-hi)
  'partyAccess.explainOpen': "Nobody is assigned, so everyone with the right role can see and work this party.",
  // TODO(i18n-hi)
  'partyAccess.explainRestricted': "Only the people below can see this party and its leads and orders. View can read; manage can also create and edit.",
  // TODO(i18n-hi)
  'partyAccess.filter.all': "All",
  // TODO(i18n-hi)
  'partyAccess.filter.open': "Open",
  // TODO(i18n-hi)
  'partyAccess.filter.restricted': "Restricted",
  // TODO(i18n-hi)
  'partyAccess.intro': "A party nobody is assigned to is open to everyone. Assign someone and only they can reach it.",
  // TODO(i18n-hi)
  'partyAccess.level.manage': "Manage",
  // TODO(i18n-hi)
  'partyAccess.level.view': "View",
  // TODO(i18n-hi)
  'partyAccess.more': "+{count} more",
  // TODO(i18n-hi)
  'partyAccess.noAssignees': "Nobody is assigned",
  // TODO(i18n-hi)
  'partyAccess.open': "Open",
  // TODO(i18n-hi)
  'partyAccess.reload': "Reload",
  // TODO(i18n-hi)
  'partyAccess.remove': "Remove",
  // TODO(i18n-hi)
  'partyAccess.restricted': "Restricted",
  // TODO(i18n-hi)
  'partyAccess.scope.all': "All parties",
  // TODO(i18n-hi)
  'partyAccess.scope.assigned': "My parties",
  // TODO(i18n-hi)
  'partyAccess.searchPlaceholder': "Search parties",
  // TODO(i18n-hi)
  'partyAccess.staleSave': "Somebody else changed this party’s access first. Reload to see it.",
  // TODO(i18n-hi)
  'partyAccess.summary': "{restricted} of {total} parties are restricted.",
  // TODO(i18n-hi)
  'partyAccess.title': "Party access",
  // TODO(i18n-hi)
  'product.codeRequired': "Enter the product code",
  // TODO(i18n-hi)
  'product.createFailed': "Could not create the product",
  // TODO(i18n-hi)
  'product.detail.adjustAction': "Adjust count",
  // TODO(i18n-hi)
  'product.detail.editAction': "Edit product",
  // TODO(i18n-hi)
  'product.detail.grade': "Grade",
  // TODO(i18n-hi)
  'product.detail.rate': "Rate / box",
  // TODO(i18n-hi)
  'product.detail.size': "Size",
  // TODO(i18n-hi)
  'product.detail.stock.colour': "Colour",
  // TODO(i18n-hi)
  'product.detail.stock.free': "Free",
  // TODO(i18n-hi)
  'product.detail.stock.none': "No stock recorded for this product yet.",
  // TODO(i18n-hi)
  'product.detail.stock.note': "Zero stock never blocks a lead — you can quote stock you have not made yet.",
  // TODO(i18n-hi)
  'product.detail.stock.onHand': "On hand",
  // TODO(i18n-hi)
  'product.detail.stock.reserved': "Reserved",
  // TODO(i18n-hi)
  'product.detail.stockForm.adjustDone': "Stock count for {colour} adjusted",
  // TODO(i18n-hi)
  'product.detail.stockForm.colour': "Colour",
  // TODO(i18n-hi)
  'product.detail.stockForm.colourRequired': "Choose a colour",
  // TODO(i18n-hi)
  'product.detail.stockForm.counted': "Counted boxes on hand",
  // TODO(i18n-hi)
  'product.detail.stockForm.failed': "Could not record the stock movement",
  // TODO(i18n-hi)
  'product.detail.stockForm.inboundDone': "{count} boxes of {colour} added to stock",
  // TODO(i18n-hi)
  'product.detail.stockForm.note': "Note",
  // TODO(i18n-hi)
  'product.detail.stockForm.noteHint': "Optional — recorded on the stock ledger",
  // TODO(i18n-hi)
  'product.detail.stockForm.quantity': "Boxes received",
  // TODO(i18n-hi)
  'product.detail.stockForm.quantityInvalid': "Enter a quantity",
  // TODO(i18n-hi)
  'product.detail.stockForm.save': "Save",
  // TODO(i18n-hi)
  'product.detail.stockForm.saving': "Saving…",
  // TODO(i18n-hi)
  'product.detail.stockInAction': "Stock in",
  // TODO(i18n-hi)
  'product.detail.stockTitle': "Stock by colour",
  // TODO(i18n-hi)
  'product.detail.type': "Type",
  // TODO(i18n-hi)
  'product.detail.weight': "Box weight",
  // TODO(i18n-hi)
  'product.edit.title': "Edit product",
  // TODO(i18n-hi)
  'product.field.series': 'सीरीज़',
  'product.field.finish': 'फ़िनिश',
  'product.field.color': 'रंग',
  'product.field.thickness': 'मोटाई (मिमी)',
  'product.field.piecesPerBox': 'प्रति बॉक्स पीस',
  'product.field.boxCoverage': 'प्रति बॉक्स कवरेज (वर्ग फुट)',
  'product.field.hsnCode': 'HSN कोड',
  'product.field.mrp': 'एमआरपी',
  'product.field.purchaseRate': 'खरीद दर',
  'product.field.purchaseRateHint': 'कंपनी जो चुकाती है। खरीद-दर कुंजी के बिना छिपी रहती है।',
  'product.field.gstRate': 'जीएसटी दर (%)',
  'product.field.uom': 'गिनती की इकाई',
  'product.field.barcode': 'बारकोड',
  'product.field.brand': 'ब्रांड',
  'product.field.shade': 'शेड',
  'product.field.calibre': 'कैलिबर',
  'product.field.waterAbsorption': 'जल अवशोषण (%)',
  'product.field.peiRating': 'PEI रेटिंग',
  'product.field.edgeType': 'किनारा',
  'product.field.surfaceTexture': 'सतह बनावट',
  'product.field.application': 'कहाँ उपयोग',
  'product.field.originPlant': 'उत्पादन संयंत्र',
  'product.group.identity': 'पहचान',
  'product.group.pricing': 'मूल्य',
  'product.group.packing': 'पैकिंग',
  'product.group.spec': 'टाइल विवरण',
  'product.group.photos': 'तस्वीरें',
  'product.uom.box': 'बॉक्स',
  'product.uom.sqft': 'वर्ग फुट',
  'product.uom.piece': 'पीस',
  'product.edge.rectified': 'रेक्टिफ़ाइड',
  'product.edge.non_rectified': 'नॉन-रेक्टिफ़ाइड',
  'product.application.floor': 'फ़र्श',
  'product.application.wall': 'दीवार',
  'product.application.floor_wall': 'फ़र्श और दीवार',
  'product.application.outdoor': 'बाहरी',
  'product.field.none': '—',
  'product.field.alias': "Alias",
  // TODO(i18n-hi)
  'product.field.code': "Product code",
  // TODO(i18n-hi)
  'product.field.grade': "Grade",
  // TODO(i18n-hi)
  'product.field.images': "Photos",
  // TODO(i18n-hi)
  'product.field.name': "Product name",
  // TODO(i18n-hi)
  'product.field.rate': "Rate per box",
  // TODO(i18n-hi)
  'product.field.rateHint': "Entered in rupees; the Master ignores this without field.saleRate.edit",
  // TODO(i18n-hi)
  'product.field.size': "Size",
  // TODO(i18n-hi)
  'product.field.type': "Type",
  // TODO(i18n-hi)
  'product.field.weight': "Box weight (kg)",
  // TODO(i18n-hi)
  'product.nameRequired': "Enter the product name",
  // TODO(i18n-hi)
  'product.new.title': "New product",
  // TODO(i18n-hi)
  'product.save': "Save product",
  // TODO(i18n-hi)
  'product.saveChanges': "Save changes",
  // TODO(i18n-hi)
  'product.saveHint': "Available in every lead form the moment it saves — online or off",
  // TODO(i18n-hi)
  'product.saving': "Saving…",
  // TODO(i18n-hi)
  'product.updated': "{name} updated",
  // TODO(i18n-hi)
  'recycleBin.action.loadMore': "Load older",
  // TODO(i18n-hi)
  'recycleBin.action.restore': "Restore",
  // TODO(i18n-hi)
  'recycleBin.column.deletedAt': "Deleted",
  // TODO(i18n-hi)
  'recycleBin.column.deletedBy': "Deleted by",
  // TODO(i18n-hi)
  'recycleBin.column.detail': "Detail",
  // TODO(i18n-hi)
  'recycleBin.column.label': "Record",
  // TODO(i18n-hi)
  'recycleBin.column.type': "Type",
  // TODO(i18n-hi)
  'recycleBin.deletedBy.panel': "Office panel",
  // TODO(i18n-hi)
  'recycleBin.denied.description': "Your role does not include {permission}.",
  // TODO(i18n-hi)
  'recycleBin.denied.title': "You cannot see the recycle bin",
  // TODO(i18n-hi)
  'recycleBin.empty.description': "Deleted records wait here until someone puts them back.",
  // TODO(i18n-hi)
  'recycleBin.empty.filtered.title': "No deleted record matches these filters",
  // TODO(i18n-hi)
  'recycleBin.empty.title': "Nothing deleted",
  // TODO(i18n-hi)
  'recycleBin.entity.custom_field_definition': "Custom field",
  // TODO(i18n-hi)
  'recycleBin.entity.document_template': "Document template",
  // TODO(i18n-hi)
  'recycleBin.entity.lead': "Lead",
  // TODO(i18n-hi)
  'recycleBin.entity.option_list_item': "Option value",
  // TODO(i18n-hi)
  'recycleBin.entity.order': "Order",
  // TODO(i18n-hi)
  'recycleBin.entity.party': "Party",
  // TODO(i18n-hi)
  'recycleBin.entity.product': "Product",
  // TODO(i18n-hi)
  'recycleBin.entity.role': "Role",
  // TODO(i18n-hi)
  'recycleBin.entity.user': "Person",
  // TODO(i18n-hi)
  'recycleBin.error.load': "Could not load the recycle bin",
  // TODO(i18n-hi)
  'recycleBin.error.restore': "Could not restore that record",
  // TODO(i18n-hi)
  'recycleBin.error.restoreParent': "Could not restore the records this one needs",
  // TODO(i18n-hi)
  'recycleBin.error.title': "Could not load the recycle bin",
  // TODO(i18n-hi)
  'recycleBin.filter.allTypes': "All types",
  // TODO(i18n-hi)
  'recycleBin.filter.anyone': "Deleted by anyone",
  // TODO(i18n-hi)
  'recycleBin.filter.deletedBy': "Deleted by",
  // TODO(i18n-hi)
  'recycleBin.filter.type': "Record type",
  // TODO(i18n-hi)
  'recycleBin.filter.typeWithCount': "{type} ({count})",
  // TODO(i18n-hi)
  'recycleBin.refusal.nameHint': "A record still in use has the original one. Edit this if you prefer another.",
  // TODO(i18n-hi)
  'recycleBin.refusal.nameLabel': "New name",
  // TODO(i18n-hi)
  'recycleBin.refusal.parentLine': "{type} · {label}",
  // TODO(i18n-hi)
  'recycleBin.refusal.parentsNotYours': "Someone allowed to restore those records has to put them back before this one can come back.",
  // TODO(i18n-hi)
  'recycleBin.refusal.parentsTitle': "Still deleted",
  // TODO(i18n-hi)
  'recycleBin.refusal.restoreAs': "Restore under this name",
  // TODO(i18n-hi)
  'recycleBin.refusal.restoreParents': "Restore those first, then this",
  // TODO(i18n-hi)
  'recycleBin.refusal.title': "Cannot restore {label} yet",
  // TODO(i18n-hi)
  'recycleBin.scope.everyone': "Everyone’s deletions",
  // TODO(i18n-hi)
  'recycleBin.scope.everyone.hint': "Showing what anyone in the company deleted.",
  // TODO(i18n-hi)
  'recycleBin.scope.own': "Your deletions",
  // TODO(i18n-hi)
  'recycleBin.scope.own.hint': "Showing what you deleted yourself.",
  // TODO(i18n-hi)
  'recycleBin.search.placeholder': "Search deleted records…",
  // TODO(i18n-hi)
  'recycleBin.title': "Recycle bin",
  // TODO(i18n-hi)
  'recycleBin.toast.restored': "{label} restored",
  // TODO(i18n-hi)
  'recycleBin.toast.restoredAs': "{label} restored as {name}",
  // TODO(i18n-hi)
  'reports.column.boxes': "Boxes",
  // TODO(i18n-hi)
  'reports.column.city': "City",
  // TODO(i18n-hi)
  'reports.column.code': "Code",
  // TODO(i18n-hi)
  'reports.column.colour': "Colour",
  // TODO(i18n-hi)
  'reports.column.converted': "Converted",
  // TODO(i18n-hi)
  'reports.column.lost': "Lost",
  // TODO(i18n-hi)
  'reports.column.month': "Month",
  // TODO(i18n-hi)
  'reports.column.open': "Still open",
  // TODO(i18n-hi)
  'reports.column.orders': "Orders",
  // TODO(i18n-hi)
  'reports.column.parties': "Parties",
  // TODO(i18n-hi)
  'reports.column.party': "Party",
  // TODO(i18n-hi)
  'reports.column.quiet': "Went quiet",
  // TODO(i18n-hi)
  'reports.column.value': "Value",
  // TODO(i18n-hi)
  'reports.dispatches.byColour': "By colour",
  // TODO(i18n-hi)
  'reports.dispatches.byMonth': "By month",
  // TODO(i18n-hi)
  'reports.dispatches.colours.empty.description': "Dispatched boxes carry a colour — none of the lines in this range did.",
  // TODO(i18n-hi)
  'reports.dispatches.colours.empty.title': "No colours to break down",
  // TODO(i18n-hi)
  'reports.dispatches.empty.description': "Nothing was dispatched in these months. Try a wider range.",
  // TODO(i18n-hi)
  'reports.empty.title': "No activity in this range",
  // TODO(i18n-hi)
  'reports.error.load': "Could not load the report",
  // TODO(i18n-hi)
  'reports.export': "Export CSV",
  // TODO(i18n-hi)
  'reports.leadOutcomes.byMonth': "By month",
  // TODO(i18n-hi)
  'reports.leadOutcomes.empty.description': "No leads were raised in these months. Try a wider range.",
  // TODO(i18n-hi)
  'reports.leadOutcomes.quietNote': "A lead counts as gone quiet after {days} days with no movement.",
  // TODO(i18n-hi)
  'reports.noPermission.description': "Ask an administrator to add {permission}.",
  // TODO(i18n-hi)
  'reports.noPermission.title': "Reports are not part of your role",
  // TODO(i18n-hi)
  'reports.period.custom': "Custom range",
  // TODO(i18n-hi)
  'reports.period.last12Months': "Last 12 months",
  // TODO(i18n-hi)
  'reports.period.last3Months': "Last 3 months",
  // TODO(i18n-hi)
  'reports.period.last6Months': "Last 6 months",
  // TODO(i18n-hi)
  'reports.period.thisMonth': "This month",
  // TODO(i18n-hi)
  'reports.range.caption': "{from} to {to} · {zone}",
  // TODO(i18n-hi)
  'reports.range.fromMonth': "From month",
  // TODO(i18n-hi)
  'reports.range.period': "Period",
  // TODO(i18n-hi)
  'reports.range.toMonth': "To month",
  // TODO(i18n-hi)
  'reports.range.toMonthHint': "Leave empty to run up to this month",
  // TODO(i18n-hi)
  'reports.ratesHidden': "Money is left out — your role does not include {permission}.",
  // TODO(i18n-hi)
  'reports.stat.boxes': "Boxes dispatched",
  // TODO(i18n-hi)
  'reports.stat.orders': "Orders dispatched",
  // TODO(i18n-hi)
  'reports.stat.value': "Value dispatched",
  // TODO(i18n-hi)
  'reports.tab.dispatches': "Dispatches",
  // TODO(i18n-hi)
  'reports.tab.leadOutcomes': "Lead outcomes",
  // TODO(i18n-hi)
  'reports.tab.topParties': "Top parties",
  // TODO(i18n-hi)
  'reports.title': "Reports",
  // TODO(i18n-hi)
  'reports.topParties.cities': "Cities",
  // TODO(i18n-hi)
  'reports.topParties.cities.empty.description': "None of these parties has a city recorded.",
  // TODO(i18n-hi)
  'reports.topParties.cities.empty.title': "No cities to group by",
  // TODO(i18n-hi)
  'reports.topParties.empty.description': "No party ordered in these months. Try a wider range.",
  // TODO(i18n-hi)
  'reports.topParties.orderedByCount': "Top {limit} by number of orders — your role does not include rates.",
  // TODO(i18n-hi)
  'reports.topParties.orderedByValue': "Top {limit} by order value.",
  // TODO(i18n-hi)
  'reports.topParties.parties': "Parties",
  // TODO(i18n-hi)
  'search.noResults': "Nothing matches “{term}”.",
  // TODO(i18n-hi)
  'search.placeholder': "Search…",
  // TODO(i18n-hi)
  'settings.appearance.density': "Density",
  // TODO(i18n-hi)
  'settings.appearance.densityComfortable': "Comfortable",
  // TODO(i18n-hi)
  'settings.appearance.densityCompact': "Compact",
  // TODO(i18n-hi)
  'settings.appearance.densityLarge': "Large",
  // TODO(i18n-hi)
  'settings.appearance.densityNote': "Row and control heights only — text size is the scale above.",
  // TODO(i18n-hi)
  'settings.appearance.motion': "Motion",
  // TODO(i18n-hi)
  'settings.appearance.motionHint': "Also honours the system's reduced-motion setting",
  // TODO(i18n-hi)
  'settings.appearance.motionLabel': "Turn animation off",
  // TODO(i18n-hi)
  'settings.appearance.subtitle': "Per-machine — never synced",
  // TODO(i18n-hi)
  'settings.appearance.theme': "Theme",
  // TODO(i18n-hi)
  'settings.appearance.themeDark': "Dark",
  // TODO(i18n-hi)
  'settings.appearance.themeLight': "Light",
  // TODO(i18n-hi)
  'settings.appearance.title': "Appearance",
  // TODO(i18n-hi)
  'settings.company.title': 'कंपनी सेटिंग्स',
  'settings.company.subtitle': 'पूरी कंपनी के लिए एक बार तय — हर मशीन के लिए नहीं।',
  'settings.company.saveFailed': 'वह सेटिंग सहेजी नहीं जा सकी',
  'settings.company.secretSet': 'सेट है',
  'settings.company.secretNotSet': 'सेट नहीं है',
  'settings.company.secretSave': 'सहेजें',
  'settings.company.editedElsewhere': 'अपनी अलग स्क्रीन से संपादित',
  'settings.vault.coverage': '{total} में से {stored} लोगों का पासवर्ड दिखाया जा सकता है',
  'settings.connection.company': "Company",
  // TODO(i18n-hi)
  'settings.connection.description': "Office Panels normally connect automatically. Use these only for manual connection.",
  // TODO(i18n-hi)
  'settings.connection.masterAddress': "Master address",
  // TODO(i18n-hi)
  'settings.connection.masterAddresses': "Master addresses",
  // TODO(i18n-hi)
  'settings.connection.masterId': "Master ID",
  // TODO(i18n-hi)
  'settings.connection.noAddress': "No network address detected — port {port}",
  // TODO(i18n-hi)
  'settings.connection.passwordNote': "The pairing password is not stored in readable form and cannot be shown again. Office Panels already connected are unaffected.",
  // TODO(i18n-hi)
  'settings.connection.setupCompleted': "Set up on",
  // TODO(i18n-hi)
  'settings.connection.state.connected': "Connected",
  // TODO(i18n-hi)
  'settings.connection.state.connecting': "Connecting…",
  // TODO(i18n-hi)
  'settings.connection.state.disconnected': "Disconnected",
  // TODO(i18n-hi)
  'settings.connection.state.unpaired': "Not paired",
  // TODO(i18n-hi)
  'settings.connection.title': "Connection details",
  // TODO(i18n-hi)
  'settings.density.comfortable': "Comfortable",
  // TODO(i18n-hi)
  'settings.density.compact': "Compact",
  // TODO(i18n-hi)
  'settings.density.label': "Density",
  // TODO(i18n-hi)
  'settings.density.large': "Large",
  // TODO(i18n-hi)
  'settings.density.note': "Row and control heights only — text size is the scale above.",
  // TODO(i18n-hi)
  'settings.machine.company': "Company",
  // TODO(i18n-hi)
  'settings.machine.connection': "Connection",
  // TODO(i18n-hi)
  'settings.machine.networkLink': "Network link",
  // TODO(i18n-hi)
  'settings.machine.panel': "Panel",
  // TODO(i18n-hi)
  'settings.machine.signedInAs': "Signed in as",
  // TODO(i18n-hi)
  'settings.machine.signedInAsOffline': "{name} · {role} (signed in offline)",
  // TODO(i18n-hi)
  'settings.machine.title': "This machine",
  // TODO(i18n-hi)
  'settings.motion.hint': "Also honours the system's reduced-motion setting",
  // TODO(i18n-hi)
  'settings.motion.label': "Motion",
  // TODO(i18n-hi)
  'settings.motion.turnOff': "Turn animation off",
  // TODO(i18n-hi)
  'settings.perMachine': "Per-machine — never synced",
  // TODO(i18n-hi)
  'settings.storage.database': "Database",
  // TODO(i18n-hi)
  'settings.storage.free': "Free space on this drive",
  // TODO(i18n-hi)
  'settings.storage.total': "Total used by this software",
  // TODO(i18n-hi)
  'settings.storage.uploads': "Images and files",
  // TODO(i18n-hi)
  'settings.sync.note': "Working offline is normal. Everything saves here first and syncs when the Master is reachable — nothing is ever lost to a dropped connection.",
  // TODO(i18n-hi)
  'settings.sync.title': "Sync",
  // TODO(i18n-hi)
  'settings.theme.dark': "Dark",
  // TODO(i18n-hi)
  'settings.theme.label': "Theme",
  // TODO(i18n-hi)
  'settings.theme.light': "Light",
  // TODO(i18n-hi)
  'shell.noModules': "Your role does not include access to any of this panel's screens. Ask an administrator if you think that is wrong.",
  // TODO(i18n-hi)
  'shell.starting': "Starting…",
  // TODO(i18n-hi)
  'shell.waitingFirstSync': "Waiting for the first sync with the Master Panel. Once it has happened, this panel keeps working whether or not the Master is reachable.",
  // TODO(i18n-hi)
  'signIn.action.signIn': "Sign in",
  // TODO(i18n-hi)
  'signIn.action.signingIn': "Signing in…",
  // TODO(i18n-hi)
  'signIn.error.default': "Sign in failed",
  // TODO(i18n-hi)
  'signIn.field.password': "Password",
  // TODO(i18n-hi)
  'signIn.field.username': "Username",
  // TODO(i18n-hi)
  'signIn.subtitle': "Enter the ID and password generated during setup.",
  // TODO(i18n-hi)
  'signin.errorFallback': "Sign-in failed",
  // TODO(i18n-hi)
  'signin.offlineNotice': "The Master Panel is not reachable right now. You can still sign in if you have used this panel before — your work will be saved here and sent when the Master returns.",
  // TODO(i18n-hi)
  'signin.password': "Password",
  // TODO(i18n-hi)
  'signin.submit': "Sign in",
  // TODO(i18n-hi)
  'signin.submitting': "Signing in…",
  // TODO(i18n-hi)
  'signin.subtitleFallback': "Sign in to continue",
  // TODO(i18n-hi)
  'signin.username': "Username",
  // TODO(i18n-hi)
  'splash.error.timeout': "The server did not answer in time.",
  // TODO(i18n-hi)
  'splash.error.unreachable': "Could not reach the server. It may still be starting up.",
  // TODO(i18n-hi)
  'splash.step.assets': "Preparing the workspace",
  // TODO(i18n-hi)
  'splash.step.ready': "Ready",
  // TODO(i18n-hi)
  'splash.step.server': "Contacting the server",
  // TODO(i18n-hi)
  'splash.step.session': "Restoring your session",
  // TODO(i18n-hi)
  'startup.failed.title': "This PC’s server could not start",
  // TODO(i18n-hi)
  'startup.failed.unknown': "The server stopped while starting up and did not say why. The server window that opened alongside this one will have the details.",
  // TODO(i18n-hi)
  'startup.waiting.body': "The panel is still starting up. On a first run it spends a little while building its database — this screen clears itself as soon as it is ready.",
  // TODO(i18n-hi)
  'startup.waiting.slow': "Still no answer. Check the server window that opened alongside this one for an error, and make sure nothing else is using its port.",
  // TODO(i18n-hi)
  'startup.waiting.step': "{step}… this screen clears itself as soon as the panel is ready.",
  // TODO(i18n-hi)
  'startup.waiting.title': "Waiting for this PC’s server",
  // TODO(i18n-hi)
  'sync.flushNow': "Sync now",
  // TODO(i18n-hi)
  'sync.flushing': "Syncing…",
  // TODO(i18n-hi)
  'sync.lastSuccessful': "Last successful sync",
  // TODO(i18n-hi)
  'sync.lowStock': "Products low on stock",
  // TODO(i18n-hi)
  'sync.pairedServer': "Paired server",
  // TODO(i18n-hi)
  'sync.panelsOnline': "Panels online",
  // TODO(i18n-hi)
  'sync.popoverTitle.conflict': "Conflicts to review",
  // TODO(i18n-hi)
  'sync.popoverTitle.syncing': "Syncing",
  // TODO(i18n-hi)
  'sync.refusedChanges': "Refused changes",
  // TODO(i18n-hi)
  'sync.synced': "Synced",
  // TODO(i18n-hi)
  'sync.syncing': "Syncing {count}",
  // TODO(i18n-hi)
  'unit.boxes': "boxes",
  // TODO(i18n-hi)
  'unit.product': "product",
  // TODO(i18n-hi)
  'unit.products': "products",
  // TODO(i18n-hi)
  'updates.ahead': "Newer than this Master",
  // TODO(i18n-hi)
  'updates.allMatch': "Every panel is on {version}, the same version as this Master.",
  // TODO(i18n-hi)
  'updates.behind': "Different version",
  // TODO(i18n-hi)
  'updates.dataStays': "Your data stays exactly where it is. The setup replaces the program only — parties, leads, orders and settings are untouched.",
  // TODO(i18n-hi)
  'updates.downloading': "Getting it from the Master…",
  // TODO(i18n-hi)
  'updates.howBody': "Copy a new build into the releases folder on this PC. This Master installs its own from there; every Office Panel pulls its own copy from this Master over the office network. Update the Master first — a panel on the previous version keeps working and syncing in the meantime.",
  // TODO(i18n-hi)
  'updates.howHint': "This network has no internet by design, so nothing here checks an update server or downloads anything on its own.",
  // TODO(i18n-hi)
  'updates.howTitle': "How updates reach this software",
  // TODO(i18n-hi)
  'updates.installFailed': "The update could not be prepared",
  // TODO(i18n-hi)
  'updates.installNow': "Install now",
  // TODO(i18n-hi)
  'updates.launchRefused': "Windows would not start the installer. Run the file yourself from the path above.",
  // TODO(i18n-hi)
  'updates.launching': "Starting the installer…",
  // TODO(i18n-hi)
  'updates.masterVersion': "Master version",
  // TODO(i18n-hi)
  'updates.needsPermission': "Ask an administrator to install this — it needs the \"Manage settings\" permission.",
  // TODO(i18n-hi)
  'updates.noFolder': "No releases folder on this PC yet, so there is nothing to install from.",
  // TODO(i18n-hi)
  'updates.noRelease': "The releases folder is there, but no build has been put in it yet.",
  // TODO(i18n-hi)
  'updates.officeReady': "Office build {version} is ready on this Master. Each panel can install it from its own App update screen.",
  // TODO(i18n-hi)
  'updates.panel.behindBody': "The Master is on {version} and this panel is on an older build. Nothing is wrong — it keeps working and syncing exactly as it does now. When a matching build is published on the Master it will appear here to install.",
  // TODO(i18n-hi)
  'updates.panel.matchBody': "This panel is on the same version as the Master. Nothing to do.",
  // TODO(i18n-hi)
  'updates.panel.offerBody': "Version {version} is waiting on the Master. Installing it copies the file to this PC first, so nothing depends on the network once it starts. Anything this panel has queued offline is kept.",
  // TODO(i18n-hi)
  'updates.panel.unknownBody': "This panel has not heard from the Master since it started, so it cannot say which version the Master is on. It will once the link is back.",
  // TODO(i18n-hi)
  'updates.panelVersion': "Panel version",
  // TODO(i18n-hi)
  'updates.panelsBehind': "On a different version",
  // TODO(i18n-hi)
  'updates.panelsTitle': "Office panel versions",
  // TODO(i18n-hi)
  'updates.panelsTracked': "Office panels paired",
  // TODO(i18n-hi)
  'updates.readyLabel': "Ready to install",
  // TODO(i18n-hi)
  'updates.runByHand': "The file is ready. Run it yourself from:",
  // TODO(i18n-hi)
  'updates.someBehind': "{count} panel(s) are on a different version from this Master ({version}). They keep working — a panel is never blocked for being out of step.",
  // TODO(i18n-hi)
  'updates.someUnknown': "{count} panel(s) have not reported a version yet. They will the next time they connect.",
  // TODO(i18n-hi)
  'updates.statusLabel': "Against the Master",
  // TODO(i18n-hi)
  'updates.table.version': "Version",
  // TODO(i18n-hi)
  'updates.thisMachine': "This Master",
  // TODO(i18n-hi)
  'updates.thisPanel': "This panel",
  // TODO(i18n-hi)
  'updates.unknown': "Unknown",
  // TODO(i18n-hi)
  'updates.upToDate': "Up to date",
  // TODO(i18n-hi)
  'updates.upToDateBody': "This is the newest build in the releases folder. Nothing to do.",
  // TODO(i18n-hi)
  'updates.verifying': "Checking the file…",
  // TODO(i18n-hi)
  'screen.reset': "Reset this screen",
  // TODO(i18n-hi)
  'screen.resetHint': "Clear the filters, scroll and unsaved entry on this screen and load it fresh.",
  // TODO(i18n-hi)
  'lead.add.discardConfirm': "Discard this lead and start over?",
  // TODO(i18n-hi)
  'settings.appearance.scale': "UI scale",
  // TODO(i18n-hi)
  'settings.appearance.scaleReset': "Reset",
  // TODO(i18n-hi)
  'settings.appearance.scaleNote': "Root {size} — this screen resizes live",
  // TODO(i18n-hi)
  'settings.scale.label': "UI scale",
  // TODO(i18n-hi)
  'settings.scale.reset': "Reset",
  // TODO(i18n-hi)
  'settings.scale.note': "Root {size} — this screen resizes live",
};
