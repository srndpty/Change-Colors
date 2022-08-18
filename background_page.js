// const LS = {
//   getAllItems: () => chrome.storage.local.get(),
//   getItem: async key => (await chrome.storage.local.get(key))[key],
//   setItem: (key, val) => chrome.storage.local.set({[key]: val}),
//   removeItems: keys => chrome.storage.local.remove(keys),
// };

const SS = chrome.storage.sync;

function CurrentPage ()
{
	console.log("function CurrentPage");

    this.blnOverrides = 
    {
		'OverridenDomains' : null,
		'OverridenPages' : null,
		'NotOverridenPages' : null,
		'NotOverridenDomains' : null,
		'OverrideAll': null
	}

    this.Overrides = 
    {
		'OverridenDomains' : new Array(), 
		'OverridenPages' : new Array(), 
		'NotOverridenPages' : new Array(), 
		'NotOverridenDomains' : new Array(), 
		'OverrideAll' : null
     }

    this.Url;
    this.Domain;
    this.CurrentTabId;

    this.getOverrides = function (){
		this.Overrides["OverridenDomains"] = SS.get('OverridenDomains');
		this.Overrides['OverridenPages'] = SS.get("OverridenPages");
		this.Overrides['NotOverridenDomains'] = SS.get("NotOverridenDomains");
		this.Overrides['NotOverridenPages'] = SS.get("NotOverridenPages");
		this.Overrides['OverrideAll'] = SS.get("OverrideAll");
    }

    this.callInjectCss = function (){	
		chrome.tabs.sendMessage(this.CurrentTabId, {action: "injectCss", css: this.CssToInject} , null);
		this.displayOverriden(this.CurrentTabId);
    }

    this.callRemoveCss = function (){
		chrome.tabs.sendMessage(this.CurrentTabId, {action: "removeCss"}, null);
    }

    this.setIsOverridenOrNot =  function (path, overrideType){
		this.blnOverrides[overrideType] = this.Overrides[overrideType].indexOf(path) != -1;
    }

    this.manageOverride = function (overrideType, blnValue, localStorageValue, action, CSSfn){
		switch(action){
		case 'add':
		    this.Overrides[overrideType].push(localStorageValue);
		    break;
		case 'remove':
		    this.Overrides[overrideType].splice(this.Overrides[overrideType].indexOf(localStorageValue),1);
		    break;
		case 'set':
		    this.Overrides[overrideType] = localStorageValue;
		    break;
		}
		SS.set({overrideType: JSON.stringify(this.Overrides[overrideType])});
		this.blnOverrides[overrideType] = blnValue;
		CSSfn();
    }

    this.isStyleOverriden = function(){
		this.setIsOverridenOrNot(this.Url, 'NotOverridenPages');
		this.setIsOverridenOrNot(this.Domain, 'NotOverridenDomains');
		this.setIsOverridenOrNot(this.Url, 'OverridenPages');
		this.setIsOverridenOrNot(this.Domain, 'OverridenDomains');
		this.blnOverrides['OverrideAll'] = loadOption('OverrideAll');
		return (this.blnOverrides['OverrideAll'] && !(this.blnOverrides['NotOverridenPages'] || this.blnOverrides['NotOverridenDomains'])) || this.blnOverrides['OverridenPages'] || this.blnOverrides['OverridenDomains'];
    }

    this.setDefaults = function(){
		setDefaultOption("OverridenDomains", new Array());
		setDefaultOption("OverridenPages", new Array());
		setDefaultOption("NotOverridenDomains", new Array());
		setDefaultOption("NotOverridenPages", new Array());
		setDefaultOption("CustomFonts", new Array());
		setDefaultOption("OverrideAll", false);
		setDefaultOption("IsNotFirstStart", true);
		setDefaultOption("DefaultBrowserFont", true);
		setDefaultOption("DefaultBrowserColor", false);
		setDefaultOption("text_color", "E8E8E8");
		setDefaultOption("background_color", "080808");
		setDefaultOption("links_color", "2E79DB");
		setDefaultOption("visited_links_color", "9B51DB");
		setDefaultOption("FontSize", "0");
		setDefaultOption("ShowImage", true);
		setDefaultOption("ShowFlash", true);
		setDefaultOption("OverrideFontName", "Arial");
    }

    this.updatePageAction = function(object){
    	var tabId;
    	if(typeof object.tabId != "undefined") {
    		tabId = object.tabId;
    	}
    	else if(typeof object.id != "undefined") {
    		tabId = object.id;
    	}
    	else {
    		tabId = object;
    	}
    	 
		chrome.tabs.get(tabId, function (tab){
		    this.CurrentTabId = tabId;
		    this.Url = tab.url;
		    this.Domain = extractDomain(tab.url);
		    if(this.isStyleOverriden()){
			this.callInjectCss();
			this.displayOverriden(tabId);
		    }
		       else
			   this.displayDefault(tabId);
	
		       chrome.action.show(tabId);
		});

    }
    
    this.updatePageActionWithBackgroundOnly = function(tab) {
    	this.CurrentTabId = tab.tabId;
    	this.Url = tab.url;
    	this.Domain = extractDomain(tab.url);
        if(this.isStyleOverriden()) {
    	    var backgroundColor = '#' + loadOption("background_color");
    	    chrome.tabs.insertCSS(tab.tabId, {
    	      code: "html, body { background-color: " + backgroundColor +  " !important; }",
    	      runAt : "document_start"
    	    });
        } 
    }

    this.displayDefault = function(tabId){
		chrome.action.setIcon({tabId: tabId, path: "icons/colors_icons_grey.png"});
    }


    this.displayOverriden = function(tabId){
		chrome.action.setIcon({tabId: tabId, path: "icons/colors_icons.png"});
    }


    this.buildCssToInject = function(){
		var backgroundColor = '#' + loadOption("background_color");
		var textColor = '#' + loadOption("text_color");
		var linksColor = '#' + loadOption("links_color");
		var visitedLinksColor = '#' + loadOption("visited_links_color");
		var fontName = loadOption("OverrideFontName");
		var fontSize = parseInt(loadOption("FontSize"));
		var defaultBrowserFont = loadOption("DefaultBrowserFont");
		var defaultBrowserColor = loadOption("DefaultBrowserColor");
		var showImages = loadOption("ShowImage");
		var showFlash = loadOption("ShowFlash");

		if(defaultBrowserColor != true){
		    var css =  'html > body, html > body * {' + 
			'background-color: '+ backgroundColor +' !important;' +
			'color: ' + textColor + ' !important;' + 
			'text-shadow: 0 !important;' +
			'-webkit-text-fill-color: none !important;}' +
			'html > body, html > body *:not([onclick]):not(:link):not(:visited) {' +
			'background-image: none !important;}' +
			'html > body a:link, html > body a:link *,' +
			'html > body a:link:hover, html > body a:link:hover *,' +
			'html > body a:link:active, html > body a:link:active * {' +
			'color: ' + linksColor + ' !important;}' +
			'html > body a:visited, html > body a:visited *,' +
			'html > body a:visited:hover, html > body a:visited:hover *,' +
			'html > body a:visited:active, html > body a:visited:active * {' +
			'color:' +  visitedLinksColor + ' !important;}';
		}
		if(defaultBrowserFont != true){
		    css += 'html > body, html > body * {' +
			'line-height: normal !important;' +
			'font-family: '+ fontName  +' !important;';
		    if(fontSize != 0){
			css += 'font-size: '+ fontSize +'pt !important;}';
		    }
		    else{
			css += '}'
		    }
		}
		if(!showImages) {
		    css += 'html > body img { display:none !important; }';
		}
		if(!showFlash){
		    css += 'html > body object { display:none !important;}';
		}
		this.CssToInject = css;
    }

    this.setDefaults();
    this.getOverrides();
    this.buildCssToInject();
}

function extractDomain(url){
    return url.match(/:\/\/(.+?)\//)[1];
}

function loadOption(optionName){
    return SS.get(optionName);
}

function saveOption(optionName, optionValue){
    SS.set({optionName: JSON.stringify(optionValue)});
}

function setDefaultOption(optionName, value){
    if(SS.get(optionName) == undefined){
		saveOption(optionName, value);
    }
}

var objCurrentPage = new CurrentPage;

function FetchCurrentPage(){
	objCurrentPage = new CurrentPage;
}


chrome.webNavigation.onCommitted.addListener(objCurrentPage.updatePageActionWithBackgroundOnly);
chrome.tabs.onActivated.addListener(objCurrentPage.updatePageAction);
chrome.tabs.onUpdated.addListener(objCurrentPage.updatePageAction);


chrome.runtime.onMessage.addListener(
  function(request, sender, sendResponse) {
      switch(request.shortCut){
      case "overridePage":
	  if(objCurrentPage.blnOverrides['OverridenPages'])
	      objCurrentPage.manageOverride('OverridenPages', false, objCurrentPage.Url, 'remove', objCurrentPage.callRemoveCss);
	  else
	      objCurrentPage.manageOverride('OverridenPages', true, objCurrentPage.Url, 'add', objCurrentPage.callInjectCss);
	  break;

      case "overrideDomain":
	  if(objCurrentPage.blnOverrides['OverridenDomains'])
	      objCurrentPage.manageOverride('OverridenDomains', false, objCurrentPage.Domain, 'remove', objCurrentPage.callRemoveCss);
	  else
	      objCurrentPage.manageOverride('OverridenDomains', true, objCurrentPage.Domain, 'add', objCurrentPage.callInjectCss);
	  break;

      case "overrideAll":
	  if(objCurrentPage.blnOverrides['OverrideAll'])
	      objCurrentPage.manageOverride('OverrideAll', false, false, 'set', objCurrentPage.callRemoveCss);
	  else
	      objCurrentPage.manageOverride('OverrideAll', true, true, 'set', objCurrentPage.callInjectCss);
	  break;
      }
  }
);