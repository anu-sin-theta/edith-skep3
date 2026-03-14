

// const getResponse = async () => {
//     const result = await fetch("https://anufied.pro");
//     const data = await result.json(); // You need to convert the raw response to JSON!
//     return data;
// };

// Now, to actually see it, you have to CALL it:
// getResponse().then(console.log);

const logSuccess = () => {
    console.log("Task complete!");
    // No return here. It just does the job and stops.
};

const result = logSuccess();
console.log(result); // result will be 'undefined'


////////////////////////////////////////////////////////////////////////////2

const outer = () => {
    let count = 0;

    return () => {
        count++;
        console.log(count);
    };
};

const counter = outer();
counter(); // What prints here?
counter(); // And what prints here?