fetch("header.html")
    .then(respuesta => respuesta.text())
    .then(datos => {
        document.getElementById("header").innerHTML = datos;
    });

fetch("footer.html")
    .then(respuesta => respuesta.text())
    .then(datos => {
        document.getElementById("footer").innerHTML = datos;
    });