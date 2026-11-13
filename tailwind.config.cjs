module.exports = {
  content: ['./views/**/*.hbs', './public/js/*.js', './src/web/*.js'],
  theme: {
    extend: {
      fontFamily: { sans: ['"Inter Variable"', 'system-ui', 'sans-serif'] },
      colors: {
        canvas: '#f6f6f4', surface: '#ffffff', line: '#e8e7e2', 'line-strong': '#d6d5ce',
        ink: { DEFAULT: '#1a1a18', soft: '#52514e', mute: '#75746e' },
        brand: { 50: '#fff3ec', 100: '#ffe3d3', 500: '#ea580c', 600: '#c94a08', 700: '#a43c07' },
        series: '#2a78d6',
      },
      boxShadow: { card: '0 1px 2px rgba(20,20,15,.04)' },
    },
  },
  plugins: [],
};
