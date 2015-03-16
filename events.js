// Attach events
window.addEventListener("load", restoreOptions);

jQuery(document).ready(function() {
	
	
	$("#browserFontDefault").on("click", function() {
		fontRadioDefault();
	});
	
	$("#browserFontOverride").on("click", function() {
		fontRadioOverride();
	});
	
	$("#fontSelectorBtn").on("click", function() {
		showFonts();
	});
	
	$("#browserColorDefault").on("click", function() {
		colorRadioDefault();
	});
	
	$("#browserColorOverride").on("click", function() {
		colorRadioOverride();
	});
	
	$("#showImageDefault").on("click", function() {
		saveOption('ShowImage', true);
	});
	
	$("#showImageOverride").on("click", function() {
		saveOption('ShowImage', false);
	});
	
	$("#showFlashDefault").on("click", function() {
		saveOption('ShowFlash', true);
	});
	
	$("#showFlashOverride").on("click", function() {
		saveOption('ShowFlash', false);
	});
	
	$("#background_color").on("change", function() {
		bindColor('background_color','backgroundColor', 'sampleBlock');
	});
	
	$("#text_color").on("change", function() {
		bindColor('text_color', 'color', 'sampleBlock');
	});
	
	$("#links_color").on("change", function() {
		bindColor('links_color', 'color', 'link');
	});
	
	$("#visited_links_color").on("change", function() {
		bindColor('visited_links_color', 'color', 'visited_link');
	});
	
	$("#addUserCustomFont").on("click", function() {
		addFont();
	});
	
	$("#userCustomFont").on("click", function() {
		$(this).val("");
	});

	$("#fontSelector").html(buildFontSelector());
	$("#fontSizeContainer").html(buildFontSizeSelector());

});
	
	

