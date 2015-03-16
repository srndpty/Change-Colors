// Attach events
window.addEventListener("load", restoreOptions);

document.addEventListener("DOMContentLoaded", function(event) { 
	document.getElementById("browserFontDefault").addEventListener("click", fontRadioDefault);
	document.getElementById("browserFontOverride").addEventListener("click", fontRadioOverride);
	document.getElementById("fontSelectorBtn").addEventListener("click", showFonts);
	document.getElementById("browserColorDefault").addEventListener("click", colorRadioDefault);
	document.getElementById("browserColorOverride").addEventListener("click", colorRadioOverride);
	document.getElementById("showImageDefault").addEventListener("click", saveOption('ShowImage', true));
	document.getElementById("showImageOverride").addEventListener("click", saveOption('ShowImage', false));
	document.getElementById("showFlashDefault").addEventListener("click", saveOption('ShowFlash', true));
	document.getElementById("showFlashOverride").addEventListener("click", saveOption('ShowFlash', false));

	document.getElementById("background_color").addEventListener("change", bindColor('background_color','backgroundColor', 'sampleBlock'));
	document.getElementById("text_color").addEventListener("change", bindColor('text_color', 'color', 'sampleBlock'));
	document.getElementById("links_color").addEventListener("change", bindColor('links_color', 'color', 'link'));
	document.getElementById("visited_links_color").addEventListener("change", bindColor('visited_links_color', 'color', 'visited_link'));


	document.getElementById("addUserCustomFont").addEventListener("click", addFont);
	document.getElementById("userCustomFont").addEventListener("click", function() {
		this.value = '';
	});


	document.getElementById("fontSelector").innerHtml = buildFontSelector();
	document.getElementById("fontSizeContainer").innerHtml = buildFontSizeSelector();
});

