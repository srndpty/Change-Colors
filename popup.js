var BackgroundPage = chrome.extension.getBackgroundPage();
var objCurrentPage = BackgroundPage.objCurrentPage;

function ChangeBtnState(BtnId, BtnText, overrideType, blnOverriden, localStorageValue, addOrRemove, overrideFn){
    var btn = document.getElementById(BtnId);
    btn.innerHTML = BtnText;
    btn.onclick = function(){objCurrentPage.manageOverride.call(this, overrideType, blnOverriden, localStorageValue, addOrRemove, overrideFn); DisplayButtons();};
}

function DisplayButtons(){
    var objPageOverrides = BackgroundPage.objCurrentPage.blnOverrides;
    var currentUrl = objCurrentPage.Url;
    var currentDomain = objCurrentPage.Domain;

    if(objPageOverrides['OverridenPages']){
	ChangeBtnState('pageOverriden', 'Remove override on this page', 'OverridenPages', false, currentUrl, 'remove', objCurrentPage.callRemoveCss);
    }
    else{
	ChangeBtnState('pageOverriden', 'Apply override on this page', 'OverridenPages', true, currentUrl, 'add', objCurrentPage.callInjectCss);
    }
    
    if(objPageOverrides['OverridenDomains']){
	ChangeBtnState('domainOverriden', 'Remove override on this domain', 'OverridenDomains', false, currentDomain, 'remove', objCurrentPage.callRemoveCss);
    }
    else{
	ChangeBtnState('domainOverriden', 'Apply override on this domain', 'OverridenDomains', true, currentDomain, 'add', objCurrentPage.callInjectCss);
    }

    if(objPageOverrides['OverrideAll']){
	if(objPageOverrides['NotOverridenPages']){
	    ChangeBtnState('pageOverriden', 'Global override on this page', 'NotOverridenPages', false, currentUrl, 'remove', objCurrentPage.callInjectCss);
	}
	else{
	    ChangeBtnState('pageOverriden', 'No global override on this page', 'NotOverridenPages', true, currentUrl, 'add', objCurrentPage.callRemoveCss);
	}

	if(objPageOverrides['NotOverridenDomains']){
	    ChangeBtnState('domainOverriden', 'Global override on this domain', 'NotOverridenDomains', false, currentDomain, 'remove', objCurrentPage.callInjectCss);
	}
	else{
	    ChangeBtnState('domainOverriden', 'No global override on this domain', 'NotOverridenDomains', true, currentDomain, 'add', objCurrentPage.callRemoveCss);
	}
	ChangeBtnState('overrideAll', 'Remove override on all pages', 'OverrideAll', false, false, 'set', objCurrentPage.callRemoveCss);
    }
    else{
	ChangeBtnState('overrideAll', 'Apply override on all pages', 'OverrideAll', true, true, 'set', objCurrentPage.callInjectCss);
    }
}

window.addEventListener("load", DisplayButtons);